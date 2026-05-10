// File-based mock storage for local dev and Playwright tests.
// Implements the same StorageProvider interface as storage.js.
// No Chrome APIs needed — runs in Node.js or plain browser context.

const DEFAULT_HISTORY_CAPACITY = 50;
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

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
  if (!encoded) return '';
  const raw = atob(encoded);
  const key = 'SyncClipboard';
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i) ^ key.charCodeAt(i % key.length);
  }
  return new TextDecoder().decode(bytes);
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
 * Create a file-based mock storage provider.
 * @param {string} [dataPath] — path to JSON file for persistence (optional, defaults to in-memory)
 * @returns {import('./storage.js').StorageProvider}
 */
export function createMockStorage(dataPath) {
  let data = {
    settings: defaultSettings(),
    history: []
  };

  async function load() {
    if (!dataPath) return;
    try {
      const fs = await import('fs');
      if (fs.existsSync(dataPath)) {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        const loaded = JSON.parse(raw);
        data = { ...data, ...loaded };
      }
    } catch {
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

    async runMigration() {
      await initPromise;
      const settings = data.settings;
      if (settings.migrationVersion !== undefined) return;
      if (settings.servers !== undefined) {
        data.settings = { ...settings, migrationVersion: 1 };
        await save();
        return;
      }
      const legacy = data._legacy || {};
      if (!legacy.webdav?.url) return;
      const hostname = new URL(legacy.webdav.url).hostname;
      data.settings = {
        servers: [{
          id: 'default',
          name: hostname,
          url: legacy.webdav.url,
          username: legacy.webdav.username || '',
          password: legacy.password || ''
        }],
        activeServerId: 'default',
        maxFileSize: settings.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
        historyCapacity: settings.historyCapacity ?? DEFAULT_HISTORY_CAPACITY,
        migrationVersion: 1
      };
      delete data._legacy;
      await save();
    },

    async getServerPassword(serverId) {
      await initPromise;
      const server = data.settings.servers?.find(s => s.id === serverId);
      return server?.password ? deobfuscate(server.password) : '';
    },

    async setServerPassword(serverId, password) {
      await initPromise;
      const servers = data.settings.servers.map(s =>
        s.id === serverId ? { ...s, password: obfuscate(password) } : s
      );
      data.settings = { ...data.settings, servers };
      await save();
    },

    async getActiveServer() {
      await initPromise;
      let server = data.settings.servers?.find(s => s.id === data.settings.activeServerId);
      if (!server && data.settings.servers?.length > 0) {
        server = data.settings.servers[0];
        data.settings.activeServerId = server.id;
        await save();
      }
      if (!server) return null;
      return {
        ...server,
        password: server.password ? deobfuscate(server.password) : ''
      };
    },

    async setActiveServer(id) {
      await initPromise;
      data.settings = { ...data.settings, activeServerId: id };
      await save();
    },

    async addServer(server) {
      await initPromise;
      const id = crypto.randomUUID();
      const newServer = {
        ...server,
        id,
        password: server.password ? obfuscate(server.password) : ''
      };
      const servers = [...(data.settings.servers || []), newServer];
      const updates = { servers };
      if (!data.settings.activeServerId) {
        updates.activeServerId = id;
      }
      data.settings = { ...data.settings, ...updates };
      await save();
      return { ...newServer, password: server.password || '' };
    },

    async updateServer(id, fields) {
      await initPromise;
      const servers = data.settings.servers.map(s => {
        if (s.id !== id) return s;
        const updated = { ...s, ...fields };
        if (fields.password !== undefined) {
          updated.password = obfuscate(fields.password);
        }
        return updated;
      });
      data.settings = { ...data.settings, servers };
      await save();
      const server = servers.find(s => s.id === id);
      return server ? { ...server, password: fields.password ?? (server.password ? deobfuscate(server.password) : '') } : null;
    },

    async deleteServer(id) {
      await initPromise;
      let { activeServerId } = data.settings;
      const servers = data.settings.servers.filter(s => s.id !== id);
      if (id === activeServerId && servers.length > 0) {
        activeServerId = servers[0].id;
      } else if (id === activeServerId) {
        activeServerId = '';
      }
      data.settings = { ...data.settings, servers, activeServerId };
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