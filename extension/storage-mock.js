// File-based mock storage for local dev and Playwright tests.
// Implements the same StorageProvider interface as storage.js.
// No Chrome APIs needed — runs in Node.js or plain browser context.

const DEFAULT_HISTORY_CAPACITY = 50;
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Create a file-based mock storage provider.
 * @param {string} [dataPath] — path to JSON file for persistence (optional, defaults to in-memory)
 * @returns {import('./storage.js').StorageProvider}
 */
export function createMockStorage(dataPath) {
  let data = {
    settings: {
      webdav: { url: '', username: '' },
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      historyCapacity: DEFAULT_HISTORY_CAPACITY
    },
    password: null,
    history: []
  };

  async function load() {
    if (!dataPath) return;
    try {
      // Node.js environment
      const fs = await import('fs');
      if (fs.existsSync(dataPath)) {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        const loaded = JSON.parse(raw);
        data = { ...data, ...loaded };
      }
    } catch {
      // Browser environment — try localStorage
      try {
        const raw = localStorage.getItem(dataPath);
        if (raw) {
          const loaded = JSON.parse(raw);
          data = { ...data, ...loaded };
        }
      } catch {
        // No persistence available, use in-memory
      }
    }
  }

  async function save() {
    if (!dataPath) return;
    try {
      const fs = await import('fs');
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      try {
        localStorage.setItem(dataPath, JSON.stringify(data));
      } catch {
        // No persistence available
      }
    }
  }

  // Load on create
  const initPromise = load();

  return {
    async getSettings() {
      await initPromise;
      return { ...data.settings };
    },

    async setSettings(settings) {
      await initPromise;
      data.settings = { ...settings };
      await save();
    },

    async getPassword() {
      await initPromise;
      return data.password;
    },

    async setPassword(password) {
      await initPromise;
      data.password = password;
      await save();
    },

    async getHistory() {
      await initPromise;
      return [...data.history];
    },

    async addHistory(item) {
      await initPromise;
      data.history.unshift({ ...item, id: makeId() });
      const max = data.settings.historyCapacity || DEFAULT_HISTORY_CAPACITY;
      if (data.history.length > max) data.history.length = max;
      await save();
    },

    async clearHistory() {
      await initPromise;
      data.history = [];
      await save();
    },

    async trimHistory() {
      await initPromise;
      const max = data.settings.historyCapacity || DEFAULT_HISTORY_CAPACITY;
      if (data.history.length <= max) return 0;
      const removed = data.history.length - max;
      data.history.length = max;
      await save();
      return removed;
    }
  };
}
