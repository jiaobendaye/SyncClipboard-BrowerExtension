// Storage abstraction layer
// All modules depend on StorageProvider interface, never on chrome.storage directly.
// Auto-selects Chrome implementation in extension context.

import { browserApi } from './browser-api.js';

const DEFAULT_HISTORY_CAPACITY = 50;
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

// Password is stored in chrome.storage.local (persistent) with XOR obfuscation.

function obfuscate(text) {
  const key = 'SyncClipboard';
  const bytes = new TextEncoder().encode(text);
  const parts = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length)));
  }
  return btoa(parts.join(''));
}

function deobfuscate(encoded) {
  const raw = atob(encoded);
  const key = 'SyncClipboard';
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i) ^ key.charCodeAt(i % key.length);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * @typedef {Object} HistoryItem
 * @property {string} id
 * @property {string} type - "Text" | "Image" | "File"
 * @property {string} text
 * @property {string} [fileName]
 * @property {number} size
 * @property {number} timestamp
 * @property {string} [direction] - "up" | "down"
 */

/**
 * @typedef {Object} ServerConfig
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} username
 * @property {string} password - XOR-obfuscated
 */

/**
 * @typedef {Object} Settings
 * @property {ServerConfig[]} servers
 * @property {string} activeServerId
 * @property {number} maxFileSize
 * @property {number} historyCapacity
 * @property {number} [migrationVersion]
 */

/**
 * @typedef {Object} StorageProvider
 * @property {function(): Promise<Settings>} getSettings
 * @property {function(Settings): Promise<void>} setSettings
 * @property {function(string): Promise<string>} getServerPassword
 * @property {function(string, string): Promise<void>} setServerPassword
 * @property {function(): Promise<ServerConfig>} getActiveServer
 * @property {function(string): Promise<void>} setActiveServer
 * @property {function(Omit<ServerConfig, 'id'>): Promise<ServerConfig>} addServer
 * @property {function(string, Partial<Omit<ServerConfig, 'id'>>): Promise<ServerConfig>} updateServer
 * @property {function(string): Promise<void>} deleteServer
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
    servers: [],
    activeServerId: '',
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    historyCapacity: DEFAULT_HISTORY_CAPACITY
  };
}

/**
 * Chrome storage implementation.
 * Settings → chrome.storage.local
 * Password → stored XOR-obfuscated within each server object
 * History → chrome.storage.local
 * @returns {StorageProvider}
 */
export function createChromeStorage() {
  async function getRawSettings() {
    const result = await browserApi.storage.local.get(['settings']);
    return result.settings || defaultSettings();
  }

  return {
    async getSettings() {
      return getRawSettings();
    },

    async setSettings(settings) {
      await browserApi.storage.local.set({ settings });
    },

    async runMigration() {
      const settings = await getRawSettings();
      if (settings.migrationVersion !== undefined) return;
      if (settings.servers !== undefined) {
        await this.setSettings({ ...settings, migrationVersion: 1 });
        return;
      }
      const result = await browserApi.storage.local.get(['webdav', 'password']);
      const { webdav, password } = result;
      if (!webdav?.url) return;
      const hostname = new URL(webdav.url).hostname;
      const migrated = {
        servers: [{
          id: 'default',
          name: hostname,
          url: webdav.url,
          username: webdav.username || '',
          password: password || ''
        }],
        activeServerId: 'default',
        maxFileSize: settings.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
        historyCapacity: settings.historyCapacity ?? DEFAULT_HISTORY_CAPACITY,
        migrationVersion: 1
      };
      await this.setSettings(migrated);
      await browserApi.storage.local.remove(['webdav', 'password']);
    },

    async getServerPassword(serverId) {
      const settings = await this.getSettings();
      const server = settings.servers?.find(s => s.id === serverId);
      return server?.password ? deobfuscate(server.password) : '';
    },

    async setServerPassword(serverId, password) {
      const settings = await this.getSettings();
      const servers = settings.servers.map(s =>
        s.id === serverId ? { ...s, password: obfuscate(password) } : s
      );
      await this.setSettings({ ...settings, servers });
    },

    async getActiveServer() {
      const settings = await this.getSettings();
      let server = settings.servers?.find(s => s.id === settings.activeServerId);
      if (!server && settings.servers?.length > 0) {
        server = settings.servers[0];
        await this.setSettings({ ...settings, activeServerId: server.id });
      }
      if (!server) return null;
      return {
        ...server,
        password: server.password ? deobfuscate(server.password) : ''
      };
    },

    async setActiveServer(id) {
      const settings = await this.getSettings();
      await this.setSettings({ ...settings, activeServerId: id });
    },

    async addServer(server) {
      const settings = await this.getSettings();
      const id = crypto.randomUUID();
      const newServer = {
        ...server,
        id,
        password: server.password ? obfuscate(server.password) : ''
      };
      const servers = [...(settings.servers || []), newServer];
      const updates = { servers };
      if (!settings.activeServerId) {
        updates.activeServerId = id;
      }
      await this.setSettings({ ...settings, ...updates });
      return { ...newServer, password: server.password || '' };
    },

    async updateServer(id, fields) {
      const settings = await this.getSettings();
      const servers = settings.servers.map(s => {
        if (s.id !== id) return s;
        const updated = { ...s, ...fields };
        if (fields.password !== undefined) {
          updated.password = obfuscate(fields.password);
        }
        return updated;
      });
      await this.setSettings({ ...settings, servers });
      const server = servers.find(s => s.id === id);
      return server ? { ...server, password: fields.password ?? (server.password ? deobfuscate(server.password) : '') } : null;
    },

    async deleteServer(id) {
      const settings = await this.getSettings();
      let { activeServerId } = settings;
      const servers = settings.servers.filter(s => s.id !== id);
      if (id === activeServerId && servers.length > 0) {
        activeServerId = servers[0].id;
      } else if (id === activeServerId) {
        activeServerId = '';
      }
      await this.setSettings({ ...settings, servers, activeServerId });
    },

    async getHistory() {
      const result = await browserApi.storage.local.get(['history']);
      return result.history || [];
    },

    async addHistory(item) {
      const history = await this.getHistory();
      history.unshift({ ...item, id: makeId() });
      const settings = await this.getSettings();
      const max = settings.historyCapacity || DEFAULT_HISTORY_CAPACITY;
      if (history.length > max) history.length = max;
      await browserApi.storage.local.set({ history });
    },

    async clearHistory() {
      await browserApi.storage.local.set({ history: [] });
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
      await browserApi.storage.local.set({ history });
      return removed;
    }
  };
}
