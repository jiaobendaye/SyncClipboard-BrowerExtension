// Browser abstraction layer — normalizes Chrome/Firefox API differences.
// Detects the runtime at module load time and exports a unified API surface.
// Follows the same auto-select pattern as storage.js / storage-mock.js.
//
// Detection note: typeof browser check works in popup and options page contexts.
// If a background service worker is added later, revisit (Firefox may not expose
// the browser global in SW context).

const isFirefox = typeof browser !== 'undefined' && browser.storage;
const isChrome = typeof chrome !== 'undefined' && chrome.storage;
const hasExtensionApi = isFirefox || isChrome;

function getStorageSession() {
  if (isFirefox) {
    return browser.storage.session || browser.storage.local;
  }
  if (isChrome) {
    return chrome.storage.session;
  }
  return undefined;
}

function getStorageLocal() {
  if (isFirefox) return browser.storage.local;
  if (isChrome) return chrome.storage.local;
  return undefined;
}

function getDownloads() {
  if (isFirefox) return browser.downloads;
  if (isChrome) return chrome.downloads;
  return undefined;
}

export const browserApi = {
  storage: {
    local: getStorageLocal(),
    session: getStorageSession(),
  },
  get downloads() {
    return getDownloads();
  },
  // Truthy when we're in an actual browser extension context.
  // Use this instead of `typeof chrome !== 'undefined'` checks.
  available: hasExtensionApi,
};
