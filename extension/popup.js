import { browserApi } from './browser-api.js';
import { createChromeStorage } from './storage.js';
import { createMockStorage } from './storage-mock.js';
import { testConnection, getProfile, putProfile, putFileData, getFileData, buildProfile, computeHash, createTextTransferBlob, downloadFile, downloadBlob } from './webdav-client.js';

const storage = browserApi.available
  ? createChromeStorage()
  : createMockStorage(typeof window !== 'undefined' ? window.__SYNC_STORAGE_PATH__ : undefined);

const els = {
  statusBar: document.getElementById('status-bar'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  previewText: document.getElementById('preview-text'),
  previewImage: document.getElementById('preview-image'),
  previewBox: document.getElementById('clipboard-preview'),
  serverPreviewText: document.getElementById('server-preview-text'),
  serverPreviewBox: document.getElementById('server-preview'),
  readBtn: document.getElementById('read-clipboard-btn'),
  fileInput: document.getElementById('file-input'),
  chooseFileBtn: document.getElementById('choose-file-btn'),
  uploadBtn: document.getElementById('upload-btn'),
  downloadBtn: document.getElementById('download-btn'),
  previewServerBtn: document.getElementById('preview-server-btn'),
  historyList: document.getElementById('history-list'),
  historyHeader: document.getElementById('history-header'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  maxSizeDisplay: document.getElementById('max-size-display'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmYes: document.getElementById('confirm-yes'),
  confirmNo: document.getElementById('confirm-no')
};

let clipboardContent = null;
const viewParams = new URLSearchParams(window.location.search);
const isStandaloneView = viewParams.get('mode') === 'standalone';
const shouldAutoPickFile = viewParams.get('pick') === 'file';

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + ' B';
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function showBanner(msg, type) {
  const existing = document.querySelector('.error-banner, .success-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.className = type === 'success' ? 'success-banner' : 'error-banner';
  banner.textContent = msg;
  els.uploadBtn.parentNode.parentNode.insertBefore(banner, els.uploadBtn.parentNode);
  setTimeout(() => banner.remove(), 5000);
}

function setPreviewText(text, placeholder) {
  els.previewImage.style.display = 'none';
  els.previewText.style.display = '';
  els.previewText.textContent = text;
  els.previewText.className = placeholder ? 'placeholder' : '';
  els.previewBox.classList.remove('empty');
}

function setPreviewImage(src) {
  els.previewText.style.display = 'none';
  els.previewImage.style.display = '';
  els.previewImage.src = src;
  els.previewBox.classList.remove('empty');
}

function resetPreview() {
  els.previewText.textContent = 'No content read yet';
  els.previewText.className = 'placeholder';
  els.previewImage.style.display = 'none';
  els.previewText.style.display = '';
  els.previewBox.classList.add('empty');
}

function setServerPreview(text, placeholder) {
  els.serverPreviewText.textContent = text;
  els.serverPreviewText.className = placeholder ? 'placeholder' : '';
  els.serverPreviewBox.classList.remove('empty');
}

function resetServerPreview() {
  els.serverPreviewText.textContent = 'Not fetched yet';
  els.serverPreviewText.className = 'placeholder';
  els.serverPreviewBox.classList.add('empty');
}

function getTextPreview(text, maxChars = 200) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

function hasExtensionRuntime() {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function';
}

function buildStandalonePopupUrl() {
  const url = hasExtensionRuntime()
    ? new URL(chrome.runtime.getURL('popup.html'))
    : new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('mode', 'standalone');
  url.searchParams.set('pick', 'file');
  return url.toString();
}

function openNativeFilePicker(bestEffort = false) {
  try {
    if (typeof els.fileInput.showPicker === 'function') {
      els.fileInput.showPicker();
    } else {
      els.fileInput.click();
    }
    return true;
  } catch {
    if (!bestEffort) {
      showBanner('Click Choose File again to open the file picker', 'error');
    }
    return false;
  }
}

function openStandaloneFilePicker() {
  const pickerWindow = window.open(
    buildStandalonePopupUrl(),
    '_blank',
    'popup=yes,width=440,height=760'
  );
  if (!pickerWindow) return false;
  if (typeof pickerWindow.focus === 'function') pickerWindow.focus();
  // Close the action popup after handing off to a regular extension page.
  window.close();
  return true;
}

function handleSelectedFile(file) {
  const isImage = file.type.startsWith('image/');
  setPreviewText(`${file.name} (${formatSize(file.size)})`);
  if (isImage) {
    const url = URL.createObjectURL(file);
    setPreviewImage(url);
  }
  clipboardContent = { type: isImage ? 'Image' : 'File', blob: file, fileName: file.name, fileSize: file.size };
  updateActionButtons();
}

function getUploadBlob(content, profile) {
  if (!profile.hasData) return null;
  if (content.blob) return content.blob;
  if (content.type === 'Text') return createTextTransferBlob(content.text || '');
  return null;
}

function saveBlobLocally(fileName, blob) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
}

function isInvalidDownloadFilenameError(err) {
  return typeof err?.message === 'string' && /invalid filename/i.test(err.message);
}

function sanitizeDownloadPathComponent(component, fallbackName) {
  const sanitized = component.replace(/^\.+/, '').replace(/\.+$/, '');
  return sanitized || fallbackName;
}

function getCompatibleDownloadFileName(fileName) {
  const path = String(fileName || '');
  const components = path.split('/');
  return components.map((component, index) => {
    const fallbackName = index === components.length - 1 ? 'download' : 'folder';
    return sanitizeDownloadPathComponent(component, fallbackName);
  }).join('/');
}

async function downloadProfileData(settings, password, fileName) {
  const downloadFileName = getCompatibleDownloadFileName(fileName);
  const needsCompatibleName = downloadFileName !== fileName;

  if (browserApi.canDownload && !needsCompatibleName) {
    try {
      await downloadFile(settings.webdav.url, settings.webdav.username, password, downloadFileName);
      return downloadFileName;
    } catch (err) {
      if (!isInvalidDownloadFilenameError(err)) throw err;
    }
  }

  const blob = await getFileData(settings.webdav.url, settings.webdav.username, password, fileName);
  if (browserApi.canDownload) {
    try {
      await downloadBlob(downloadFileName, blob);
      return downloadFileName;
    } catch {
      // Fall back to DOM-triggered download below.
    }
  }
  saveBlobLocally(downloadFileName, blob);
  return downloadFileName;
}

let serverConnected = false;

function setButtons(enabled) {
  if (!enabled) {
    els.readBtn.disabled = true;
    els.chooseFileBtn.disabled = true;
    els.uploadBtn.disabled = true;
    els.downloadBtn.disabled = true;
    els.previewServerBtn.disabled = true;
  } else {
    els.readBtn.disabled = false;
    els.chooseFileBtn.disabled = false;
    updateActionButtons();
  }
}

function updateActionButtons() {
  els.uploadBtn.disabled = !serverConnected || !clipboardContent;
  els.downloadBtn.disabled = !serverConnected;
  els.previewServerBtn.disabled = !serverConnected;
}

function setStatus(connected, url) {
  if (!url) {
    els.statusDot.className = 'dot disconnected';
    els.statusText.textContent = 'No server configured — click to set up';
  } else {
    els.statusDot.className = connected ? 'dot connected' : 'dot disconnected';
    els.statusText.textContent = connected ? url : 'Disconnected — click to reconfigure';
  }
}

async function checkConnection() {
  els.statusDot.className = 'dot checking';
  els.statusText.textContent = 'Checking...';
  try {
    const settings = await storage.getSettings();
    if (!settings.webdav.url) {
      setStatus(false, '');
      serverConnected = false;
      updateActionButtons();
      return;
    }
    const password = await storage.getPassword();
    const ok = await testConnection(settings.webdav.url, settings.webdav.username, password);
    serverConnected = ok;
    updateActionButtons();
    setStatus(ok, settings.webdav.url);
  } catch {
    serverConnected = false;
    updateActionButtons();
    setStatus(false, (await storage.getSettings()).webdav.url || '');
  }
}

async function loadMaxSize() {
  const settings = await storage.getSettings();
  els.maxSizeDisplay.textContent = 'Max upload: ' + formatSize(settings.maxFileSize);
}

async function loadHistory() {
  const history = await storage.getHistory();
  const settings = await storage.getSettings();
  const capacity = settings.historyCapacity || 50;
  els.historyHeader.textContent = history.length ? `Recent (${history.length}/${capacity})` : 'Recent';
  els.historyList.innerHTML = '';
  for (const item of history) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const icon = item.type === 'Text' ? '&#x1F4CB;' : item.type === 'Image' ? '&#x1F5BC;' : '&#x1F4C4;';
    const directionIcon = item.direction === 'up' ? '&#x2191;' : '&#x2193;';
    li.innerHTML = `<span class="direction-icon">${directionIcon}</span><span class="type-icon">${icon}</span><span class="item-text">${escapeHtml(item.text)}</span><span class="item-time">${formatTime(item.timestamp)}</span>`;
    li.addEventListener('click', () => reDownload(item));
    els.historyList.appendChild(li);
  }
  els.clearHistoryBtn.disabled = history.length === 0;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function reDownload(item) {
  if (item.type === 'Text' && !item.fileName) {
    setPreviewText(item.text);
    clipboardContent = { type: 'Text', text: item.text, blob: null };
    updateActionButtons();
  }
}

els.chooseFileBtn.addEventListener('click', () => {
  if (hasExtensionRuntime() && !isStandaloneView && openStandaloneFilePicker()) return;
  openNativeFilePicker();
});

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  handleSelectedFile(file);
  els.fileInput.value = '';
});

els.readBtn.addEventListener('click', async () => {
  try {
    els.readBtn.textContent = 'Reading...';
    els.readBtn.disabled = true;

    const items = await navigator.clipboard.read();
    if (!items.length) {
      resetPreview();
      showBanner('No content in clipboard', 'error');
      return;
    }

    const item = items[0];
    const hasImage = item.types.some(t => t.startsWith('image/'));

    if (hasImage) {
      const imageType = item.types.includes('image/png') ? 'image/png'
        : item.types.find(t => t.startsWith('image/'));
      const blob = await item.getType(imageType);
      const url = URL.createObjectURL(blob);
      setPreviewImage(url);
      const ext = imageType.split('/')[1] === 'jpeg' ? 'jpg' : imageType.split('/')[1];
      clipboardContent = { type: 'Image', blob, fileName: null, fileSize: blob.size, mimeType: imageType, ext };
      updateActionButtons();
    } else {
      const text = await navigator.clipboard.readText();
      if (!text) {
        resetPreview();
        showBanner('No content in clipboard', 'error');
        return;
      }
      setPreviewText(getTextPreview(text));
      clipboardContent = { type: 'Text', text, blob: null };
      updateActionButtons();
    }
  } catch (err) {
    resetPreview();
    showBanner(err.message || 'Failed to read clipboard', 'error');
  } finally {
    els.readBtn.textContent = 'Read Clipboard';
    els.readBtn.disabled = false;
  }
});

els.uploadBtn.addEventListener('click', async () => {
  if (!clipboardContent) return;

  const settings = await storage.getSettings();
  if (!settings.webdav.url) {
    showBanner('Configure WebDAV server in Settings first', 'error');
    return;
  }

  try {
    setButtons(false);
    els.uploadBtn.textContent = 'Uploading...';

    const content = clipboardContent;
    const password = await storage.getPassword();
    const profile = await buildProfile(content);
    const uploadBlob = getUploadBlob(content, profile);

    if (uploadBlob && uploadBlob.size > settings.maxFileSize) {
      showBanner('File exceeds maximum upload size (' + formatSize(settings.maxFileSize) + ')', 'error');
      return;
    }

    if (profile.hasData) {
      if (!uploadBlob) {
        throw new Error('Missing transfer data for upload');
      }
      const fileName = profile.dataName;
      await putFileData(settings.webdav.url, settings.webdav.username, password, fileName, uploadBlob);
    }

    await putProfile(settings.webdav.url, settings.webdav.username, password, profile);

    await storage.addHistory({
      type: profile.type,
      text: profile.text,
      fileName: profile.dataName,
      size: profile.size,
      timestamp: Date.now(),
      direction: 'up'
    });

    showBanner('Uploaded successfully', 'success');
    await loadHistory();
  } catch (err) {
    showBanner(err.message || 'Upload failed', 'error');
  } finally {
    setButtons(true);
    els.uploadBtn.textContent = 'Upload';
  }
});

els.downloadBtn.addEventListener('click', async () => {
  const settings = await storage.getSettings();
  if (!settings.webdav.url) {
    showBanner('Configure WebDAV server in Settings first', 'error');
    return;
  }

  try {
    setButtons(false);
    els.downloadBtn.textContent = 'Downloading...';

    const password = await storage.getPassword();
    const profile = await getProfile(settings.webdav.url, settings.webdav.username, password);

    if (profile.type === 'Text') {
      let text = profile.text || '';
      if (profile.hasData) {
        const blob = await getFileData(settings.webdav.url, settings.webdav.username, password, profile.dataName);
        text = await blob.text();
      }

      setPreviewText(getTextPreview(text || '(empty)'));
      clipboardContent = { type: 'Text', text, blob: null };
      updateActionButtons();

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // clipboard write may fail outside extension context
      }

      await storage.addHistory({
        type: 'Text',
        text: profile.hasData ? profile.text : text,
        fileName: profile.hasData ? profile.dataName : null,
        size: profile.size,
        timestamp: Date.now(),
        direction: 'down'
      });
      await loadHistory();
      showBanner('Copied to clipboard', 'success');
    } else {
      const savedFileName = await downloadProfileData(settings, password, profile.dataName);

      await storage.addHistory({
        type: profile.type,
        text: profile.text,
        fileName: profile.dataName,
        size: profile.size,
        timestamp: Date.now(),
        direction: 'down'
      });
      await loadHistory();
      const bannerMessage = savedFileName === profile.dataName
        ? 'Downloaded: ' + savedFileName
        : 'Downloaded as: ' + savedFileName;
      showBanner(bannerMessage, 'success');
    }
  } catch (err) {
    if (err.message && err.message.includes('404')) {
      showBanner('No clipboard on server', 'error');
    } else {
      showBanner(err.message || 'Download failed', 'error');
    }
  } finally {
    setButtons(true);
    els.downloadBtn.textContent = 'Download';
  }
});

els.previewServerBtn.addEventListener('click', async () => {
  if (els.previewServerBtn.disabled) return;

  const settings = await storage.getSettings();
  if (!settings.webdav.url) {
    showBanner('Configure WebDAV server in Settings first', 'error');
    return;
  }

  setButtons(false);
  els.previewServerBtn.textContent = 'Loading...';

  setServerPreview('Loading server content...', true);

  try {
    const password = await storage.getPassword();
    const TIMEOUT_MS = 10000;
    const timeoutError = new Error('Preview timed out');
    timeoutError.name = 'TimeoutError';
    const profile = await Promise.race([
      getProfile(settings.webdav.url, settings.webdav.username, password),
      new Promise((_, reject) => setTimeout(() => reject(timeoutError), TIMEOUT_MS))
    ]);

    if (profile.hash === '' && profile.text === '' && !profile.hasData) {
      setServerPreview('No clipboard on server', true);
      return;
    }

    let displayText;
    if (profile.type === 'Text' && !profile.hasData) {
      const preview = getTextPreview(profile.text || '(empty)');
      displayText = preview;
    } else if (profile.type === 'Text' && profile.hasData) {
      displayText = '[Text] ' + profile.dataName + ' (' + formatSize(profile.size) + ')';
    } else if (profile.type === 'Image') {
      displayText = '[Image] ' + profile.dataName + ' (' + formatSize(profile.size) + ')';
    } else if (profile.type === 'File') {
      displayText = '[File] ' + profile.dataName + ' (' + formatSize(profile.size) + ')';
    } else if (profile.type === 'Group') {
      displayText = '[Group] (not previewable)';
    } else {
      displayText = '(empty)';
    }
    setServerPreview(displayText);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      setServerPreview('Server did not respond', true);
    } else {
      showBanner(err.message || 'Preview failed', 'error');
      resetServerPreview();
    }
  } finally {
    els.previewServerBtn.textContent = 'Preview';
    setButtons(true);
  }
});

els.clearHistoryBtn.addEventListener('click', () => {
  els.confirmDialog.style.display = 'flex';
});

els.confirmYes.addEventListener('click', async () => {
  await storage.clearHistory();
  await loadHistory();
  els.confirmDialog.style.display = 'none';
});

els.confirmNo.addEventListener('click', () => {
  els.confirmDialog.style.display = 'none';
});

els.confirmDialog.addEventListener('click', (e) => {
  if (e.target === els.confirmDialog) els.confirmDialog.style.display = 'none';
});

els.statusBar.addEventListener('click', () => {
  window.open('options.html', '_blank');
});

async function init() {
  await loadMaxSize();
  await loadHistory();
  await checkConnection();

  if (isStandaloneView && shouldAutoPickFile) {
    setPreviewText('Choose a file in this window. It stays open during selection.', true);
    els.chooseFileBtn.focus();
    setTimeout(() => openNativeFilePicker(true), 50);
  }
}

init();
