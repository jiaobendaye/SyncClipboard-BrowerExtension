// Storage abstraction layer
// All modules depend on StorageProvider interface, never on chrome.storage directly.
// Auto-selects Chrome implementation in extension context.

const DEFAULT_HISTORY_CAPACITY = 50;
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * @typedef {Object} HistoryItem
 * @property {string} id
 * @property {string} type - "Text" | "Image" | "File"
 * @property {string} text
 * @property {string} [fileName]
 * @property {number} size
 * @property {number} timestamp
 */

/**
 * @typedef {Object} WebdavSettings
 * @property {string} url
 * @property {string} username
 */

/**
 * @typedef {Object} Settings
 * @property {WebdavSettings} webdav
 * @property {number} maxFileSize
 */

/**
 * @typedef {Object} StorageProvider
 * @property {function(): Promise<Settings>} getSettings
 * @property {function(Settings): Promise<void>} setSettings
 * @property {function(): Promise<string|null>} getPassword
 * @property {function(string): Promise<void>} setPassword
 * @property {function(): Promise<HistoryItem[]>} getHistory
 * @property {function(HistoryItem): Promise<void>} addHistory
 * @property {function(): Promise<void>} clearHistory
 * @property {function(): Promise<number>} trimHistory — trim history to configured capacity, returns count removed
 */

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultSettings() {
  return {
    webdav: { url: '', username: '' },
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    historyCapacity: DEFAULT_HISTORY_CAPACITY
  };
}

/**
 * Chrome storage implementation.
 * Settings → chrome.storage.local
 * Password → chrome.storage.session (cleared on browser close)
 * History → chrome.storage.local
 * @returns {StorageProvider}
 */
export function createChromeStorage() {
  return {
    async getSettings() {
      const result = await chrome.storage.local.get(['settings']);
      return result.settings || defaultSettings();
    },

    async setSettings(settings) {
      await chrome.storage.local.set({ settings });
    },

    async getPassword() {
      const result = await chrome.storage.session.get(['password']);
      return result.password || null;
    },

    async setPassword(password) {
      await chrome.storage.session.set({ password });
    },

    async getHistory() {
      const result = await chrome.storage.local.get(['history']);
      return result.history || [];
    },

    async addHistory(item) {
      const history = await this.getHistory();
      history.unshift({ ...item, id: makeId() });
      const settings = await this.getSettings();
      const max = settings.historyCapacity || DEFAULT_HISTORY_CAPACITY;
      if (history.length > max) history.length = max;
      await chrome.storage.local.set({ history });
    },

    async clearHistory() {
      await chrome.storage.local.set({ history: [] });
    },

    async trimHistory() {
      const [history, settings] = await Promise.all([
        this.getHistory(),
        this.getSettings()
      ]);
      const max = settings.historyCapacity || DEFAULT_HISTORY_CAPACITY;
      if (history.length <= max) return 0;
      const removed = history.length - max;
      history.length = max;
      await chrome.storage.local.set({ history });
      return removed;
    }
  };
}
