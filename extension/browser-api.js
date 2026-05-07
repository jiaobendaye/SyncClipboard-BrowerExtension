// Browser abstraction layer — normalizes Chrome/Firefox API differences.
// Detects the runtime at module load time and exports a unified API surface.
// Follows the same auto-select pattern as storage.js / storage-mock.js.
//
// Detection note: typeof browser check works in popup and options page contexts.
// If a background service worker is added later, revisit (Firefox may not expose
// the browser global in SW context).

function getBrowserNamespace() {
  return typeof browser !== 'undefined' ? browser : undefined;
}

function getChromeNamespace() {
  return typeof chrome !== 'undefined' ? chrome : undefined;
}

function hasExtensionApi() {
  return Boolean(getBrowserNamespace()?.storage || getChromeNamespace()?.storage);
}

function getStorageSession() {
  const browserNamespace = getBrowserNamespace();
  if (browserNamespace?.storage) {
    return browserNamespace.storage.session || browserNamespace.storage.local;
  }
  const chromeNamespace = getChromeNamespace();
  if (chromeNamespace?.storage) {
    return chromeNamespace.storage.session;
  }
  return undefined;
}

function getStorageLocal() {
  const browserNamespace = getBrowserNamespace();
  if (browserNamespace?.storage) return browserNamespace.storage.local;
  const chromeNamespace = getChromeNamespace();
  if (chromeNamespace?.storage) return chromeNamespace.storage.local;
  return undefined;
}

function getDownloadsApi() {
  const browserNamespace = getBrowserNamespace();
  if (typeof browserNamespace?.downloads?.download === 'function') {
    return { api: browserNamespace.downloads, runtime: browserNamespace.runtime, mode: 'promise' };
  }

  const chromeNamespace = getChromeNamespace();
  if (typeof chromeNamespace?.downloads?.download === 'function') {
    return { api: chromeNamespace.downloads, runtime: chromeNamespace.runtime, mode: 'callback' };
  }

  return null;
}

async function download(options) {
  const downloadsApi = getDownloadsApi();
  if (!downloadsApi) {
    throw new Error('Downloads API unavailable');
  }

  if (downloadsApi.mode === 'promise') {
    return downloadsApi.api.download(options);
  }

  return new Promise((resolve, reject) => {
    downloadsApi.api.download(options, (downloadId) => {
      if (downloadsApi.runtime?.lastError) {
        reject(new Error(downloadsApi.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

export const browserApi = {
  storage: {
    get local() {
      return getStorageLocal();
    },
    get session() {
      return getStorageSession();
    },
  },
  get canDownload() {
    return Boolean(getDownloadsApi());
  },
  download,
  // Truthy when we're in an actual browser extension context.
  // Use this instead of `typeof chrome !== 'undefined'` checks.
  get available() {
    return hasExtensionApi();
  },
};
