import { createChromeStorage } from './storage.js';
import { createMockStorage } from './storage-mock.js';
import { testConnection } from './webdav-client.js';

const storage = (typeof chrome !== 'undefined' && chrome.storage)
  ? createChromeStorage()
  : createMockStorage(typeof window !== 'undefined' ? window.__SYNC_STORAGE_PATH__ : undefined);

const els = {
  url: document.getElementById('webdav-url'),
  username: document.getElementById('webdav-username'),
  password: document.getElementById('webdav-password'),
  testBtn: document.getElementById('test-connection-btn'),
  testResult: document.getElementById('test-result'),
  maxSizeInput: document.getElementById('max-size-input'),
  maxSizeError: document.getElementById('max-size-error'),
  historyCapacityInput: document.getElementById('history-capacity-input'),
  historyCapacityError: document.getElementById('history-capacity-error'),
  saveBtn: document.getElementById('save-btn'),
  saveResult: document.getElementById('save-result')
};

async function loadSettings() {
  const settings = await storage.getSettings();
  els.url.value = settings.webdav.url || '';
  els.username.value = settings.webdav.username || '';

  els.maxSizeInput.value = Math.round(settings.maxFileSize / (1024 * 1024));

  const capacity = settings.historyCapacity || 50;
  els.historyCapacityInput.value = capacity;

  try {
    const password = await storage.getPassword();
    if (password) els.password.value = password;
  } catch {
    // password not available in all storage backends
  }
}

els.testBtn.addEventListener('click', async () => {
  els.testBtn.disabled = true;
  els.testBtn.textContent = 'Testing...';
  els.testResult.textContent = '';
  els.testResult.className = 'testing';

  try {
    const ok = await testConnection(els.url.value, els.username.value, els.password.value);
    els.testResult.textContent = ok ? 'Connected' : 'Failed';
    els.testResult.className = ok ? 'success' : 'error';
    if (ok) await doSave();
  } catch (err) {
    els.testResult.textContent = 'Failed: ' + err.message;
    els.testResult.className = 'error';
  } finally {
    els.testBtn.disabled = false;
    els.testBtn.textContent = 'Test Connection';
  }
});

async function doSave() {
  els.saveBtn.disabled = true;
  els.saveBtn.textContent = 'Saving...';
  els.saveResult.textContent = '';
  els.saveResult.className = '';
  els.historyCapacityError.textContent = '';
  els.maxSizeError.textContent = '';

  const rawCapacity = parseInt(els.historyCapacityInput.value);
  if (isNaN(rawCapacity) || rawCapacity < 1 || rawCapacity > 500) {
    els.historyCapacityError.textContent = 'Enter a number between 1 and 500';
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = 'Save Settings';
    return;
  }

  const rawMaxSize = parseFloat(els.maxSizeInput.value);
  if (isNaN(rawMaxSize) || rawMaxSize < 1 || rawMaxSize > 1024) {
    els.maxSizeError.textContent = 'Enter a number between 1 and 1024';
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = 'Save Settings';
    return;
  }

  try {
    await storage.setSettings({
      webdav: {
        url: els.url.value,
        username: els.username.value
      },
      maxFileSize: Math.round(parseFloat(els.maxSizeInput.value) * 1024 * 1024),
      historyCapacity: parseInt(els.historyCapacityInput.value)
    });

    if (els.password.value) {
      await storage.setPassword(els.password.value);
    }

    const trimmed = await storage.trimHistory();
    if (trimmed > 0) {
      els.saveResult.textContent = `Saved — ${trimmed} old item${trimmed > 1 ? 's' : ''} removed`;
    } else {
      els.saveResult.textContent = 'Saved';
    }
    els.saveResult.className = 'success';
  } catch (err) {
    els.saveResult.textContent = 'Save failed: ' + err.message;
    els.saveResult.className = 'error';
  } finally {
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = 'Save Settings';
  }
}

els.saveBtn.addEventListener('click', () => doSave());

loadSettings();
