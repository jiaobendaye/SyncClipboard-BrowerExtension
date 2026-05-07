// SyncClipboard WebDAV Protocol Client
// Implements the Reference SyncClipboard.json protocol for cross-device compatibility.
// Zero dependencies — uses only fetch() and Web Crypto API.

const PROFILE_PATH = '/SyncClipboard.json';
const FILE_DIR = '/file';
const TIMEOUT_MS = 30000;
const TEXT_INLINE_MAX_BYTES = 1024;

/**
 * @typedef {Object} ProfileDto
 * @property {string} type - "Text" | "Image" | "File" | "Group"
 * @property {string} hash - SHA-256 hex (uppercase)
 * @property {string} text - preview text or filename
 * @property {boolean} hasData
 * @property {string} [dataName]
 * @property {number} size
 */

function base64Encode(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function authHeaders(username, password) {
  if (!username && !password) return {};
  return { 'Authorization': 'Basic ' + base64Encode(username + ':' + password) };
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

async function request(method, baseUrl, username, password, path, body, contentType) {
  const url = stripTrailingSlash(baseUrl) + path;
  const headers = { ...authHeaders(username, password) };
  if (contentType) headers['Content-Type'] = contentType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test WebDAV connection via PROPFIND.
 * Uses XMLHttpRequest with credentials passed to open() — this tells Chrome
 * that credentials were already provided, suppressing the native auth dialog
 * even when the server returns 401.
 * @returns {Promise<boolean>}
 */
export function testConnection(baseUrl, username, password) {
  return new Promise((resolve) => {
    const url = stripTrailingSlash(baseUrl) + '/';
    const xhr = new XMLHttpRequest();
    xhr.open('PROPFIND', url, true, username || '', password || '');
    xhr.setRequestHeader('Content-Type', 'application/xml');
    xhr.timeout = TIMEOUT_MS;
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 || xhr.status === 207);
    xhr.onerror = () => resolve(false);
    xhr.ontimeout = () => resolve(false);
    xhr.send();
  });
}

/**
 * Download profile from WebDAV server.
 * 404 → returns blank Text profile (first use / empty server).
 * @returns {Promise<ProfileDto>}
 */
export async function getProfile(baseUrl, username, password) {
  const res = await request('GET', baseUrl, username, password, PROFILE_PATH);
  if (res.status === 404) {
    return { type: 'Text', hash: '', text: '', hasData: false, size: 0 };
  }
  if (!res.ok) {
    throw new Error(`Failed to get profile: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Upload profile to WebDAV server.
 * @param {ProfileDto} profile
 */
export async function putProfile(baseUrl, username, password, profile) {
  await ensureDir(baseUrl, username, password, '/');
  const res = await request('PUT', baseUrl, username, password, PROFILE_PATH, JSON.stringify(profile), 'application/json');
  if (!res.ok) {
    throw new Error(`Failed to put profile: HTTP ${res.status}`);
  }
}

/**
 * Download file data from WebDAV server.
 * @returns {Promise<Blob>}
 */
export async function getFileData(baseUrl, username, password, fileName) {
  await ensureDir(baseUrl, username, password, FILE_DIR);
  const path = `${FILE_DIR}/${encodeURIComponent(fileName)}`;
  const res = await request('GET', baseUrl, username, password, path);
  if (!res.ok) {
    throw new Error(`Failed to download file ${fileName}: HTTP ${res.status}`);
  }
  return res.blob();
}

/**
 * Upload file data to WebDAV server.
 * @param {Blob} blob
 */
export async function putFileData(baseUrl, username, password, fileName, blob) {
  await ensureDir(baseUrl, username, password, FILE_DIR);
  const path = `${FILE_DIR}/${encodeURIComponent(fileName)}`;
  const res = await request('PUT', baseUrl, username, password, path, blob, 'application/octet-stream');
  if (!res.ok) {
    throw new Error(`Failed to upload file ${fileName}: HTTP ${res.status}`);
  }
}

async function ensureDir(baseUrl, username, password, dirPath) {
  try {
    const res = await request('MKCOL', baseUrl, username, password, dirPath);
    // 405 or 409 means directory already exists — OK
    if (!res.ok && res.status !== 405 && res.status !== 409) {
      throw new Error(`Failed to create directory: HTTP ${res.status}`);
    }
  } catch (e) {
    // Network error during MKCOL on an existing dir is also OK
    if (e.message && e.message.includes('405') || e.message && e.message.includes('409')) return;
    throw e;
  }
}

/**
 * Compute SHA-256 hash of content, hex-encoded uppercase.
 * Matches Reference's CalculateSHA256() which uses Convert.ToHexString()
 * (C#) and .toUpperCase() (mobile).
 * @param {Blob|string} data - Blob or string to hash
 * @returns {Promise<string>}
 */
export async function computeHash(data) {
  let arrayBuffer;
  if (typeof data === 'string') {
    arrayBuffer = new TextEncoder().encode(data).buffer;
  } else {
    arrayBuffer = await data.arrayBuffer();
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Compute the profile hash for file-backed content.
 * Matches Reference server rule (calculateFileProfileHash in mobile):
 *   profileHash = SHA256(fileName + "|" + contentHash.ToUpper())
 * @param {string} fileName
 * @param {Blob} contentBlob
 * @returns {Promise<string>}
 */
export async function computeProfileHash(fileName, contentBlob) {
  const contentHash = await computeHash(contentBlob);
  const combined = `${fileName}|${contentHash}`;
  return computeHash(combined);
}

/**
 * Build a ProfileDto from clipboard content.
 * @param {Object} content - {type, text?, blob?, fileName?, fileSize?}
 * @returns {Promise<ProfileDto>}
 */
export async function buildProfile(content) {
  const { type, text = '', blob, fileName, fileSize } = content;

  if (type === 'Text' && (!blob || (text.length < TEXT_INLINE_MAX_BYTES && !fileName))) {
    const shortText = text.length > 100 ? text.slice(0, 100) + '...' : text;
    const result = {
      type: 'Text',
      hash: await computeHash(text),
      text: shortText,
      hasData: false,
      size: text.length
    };
    return result;
  }

  const dataName = fileName || generateFileName(type, blob);
  const size = fileSize || (blob ? blob.size : text.length);
  const displayText = type === 'Text' ? (text.length > 100 ? text.slice(0, 100) + '...' : text) : dataName;

  const hash = blob ? await computeProfileHash(dataName, blob) : await computeHash(text);

  return {
    type,
    hash,
    text: displayText,
    hasData: true,
    dataName,
    size
  };
}

function generateFileName(type, blob) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  if (type === 'Text') return `syncclipboard-${ts}-text.txt`;
  if (type === 'Image') {
    const ext = blob?.type === 'image/png' ? 'png'
      : blob?.type === 'image/jpeg' ? 'jpg'
      : blob?.type === 'image/webp' ? 'webp'
      : blob?.type === 'image/gif' ? 'gif'
      : 'png';
    return `syncclipboard-${ts}-image.${ext}`;
  }
  return `syncclipboard-${ts}-file.bin`;
}

/**
 * Download a file from the server and save via chrome.downloads.
 * Uses direct URL with auth headers so chrome.downloads respects the filename.
 * @param {string} baseUrl
 * @param {string} username
 * @param {string} password
 * @param {string} fileName
 * @returns {Promise<number>} downloadId
 */
export async function downloadFile(baseUrl, username, password, fileName) {
  const url = stripTrailingSlash(baseUrl) + `${FILE_DIR}/${encodeURIComponent(fileName)}`;
  const headers = [];
  if (username || password) {
    headers.push({ name: 'Authorization', value: 'Basic ' + base64Encode(username + ':' + password) });
  }
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename: fileName, headers, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

export { TEXT_INLINE_MAX_BYTES };
