import { browserApi } from './browser-api.js';
import { createChromeStorage } from './storage.js';
import { createMockStorage } from './storage-mock.js';
import { testConnection } from './webdav-client.js';

const storage = browserApi.available
  ? createChromeStorage()
  : createMockStorage(typeof window !== 'undefined' ? window.__SYNC_STORAGE_PATH__ : undefined);

// DOM element references
const els = {
  serverList: document.getElementById('server-list'),
  addServerBtn: document.getElementById('add-server-btn'),
  editForm: document.getElementById('server-edit-form'),
  editFormHeader: document.getElementById('edit-form-header'),
  serverNameInput: document.getElementById('server-name-input'),
  serverUrlInput: document.getElementById('server-url-input'),
  serverUsernameInput: document.getElementById('server-username-input'),
  serverPasswordInput: document.getElementById('server-password-input'),
  testBtn: document.getElementById('test-connection-btn'),
  testResult: document.getElementById('test-result'),
  cancelEditBtn: document.getElementById('cancel-edit-btn'),
  saveServerBtn: document.getElementById('save-server-btn'),
  maxSizeInput: document.getElementById('max-size-input'),
  maxSizeError: document.getElementById('max-size-error'),
  historyCapacityInput: document.getElementById('history-capacity-input'),
  historyCapacityError: document.getElementById('history-capacity-error'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  saveResult: document.getElementById('save-result'),
  activateFeedback: document.getElementById('activate-feedback'),
  deleteConfirmDialog: document.getElementById('delete-confirm-dialog'),
  deleteConfirmMessage: document.getElementById('delete-confirm-message'),
  deleteConfirmYes: document.getElementById('delete-confirm-yes'),
  deleteConfirmNo: document.getElementById('delete-confirm-no')
};

let editingServerId = null;
let settings = null;

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function renderServerCard(server) {
  const isActive = server.id === settings.activeServerId;
  const isEditing = server.id === editingServerId;

  const card = document.createElement('div');
  card.className = 'server-card' + (isActive ? ' active-server' : '');
  card.setAttribute('role', 'listitem');
  card.dataset.serverId = server.id;

  card.innerHTML = `
    <div class="server-info">
      <div class="server-name">${escapeHtml(server.name || getHostname(server.url))}</div>
      <div class="server-url">${escapeHtml(server.url)}</div>
    </div>
    ${isActive ? '<span class="active-badge">Active</span>' : ''}
    <div class="server-actions">
      <button class="icon-btn edit-btn" title="Edit" aria-label="Edit ${escapeHtml(server.name)}">&#9998;</button>
      <button class="icon-btn delete-btn" title="Delete" aria-label="Delete ${escapeHtml(server.name)}">&#128465;</button>
    </div>
  `;

  card.querySelector('.edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    showEditForm(server.id);
  });

  card.querySelector('.delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    handleDelete(server.id);
  });

  card.addEventListener('click', async () => {
    if (server.id === settings.activeServerId) return;
    await storage.setActiveServer(server.id);
    settings = await storage.getSettings();
    renderServerList();
    showSectionFeedback('✓ ' + (server.name || getHostname(server.url)));
  });

  return card;
}

function showSectionFeedback(msg, isError = false) {
  els.activateFeedback.textContent = msg;
  els.activateFeedback.className = 'activate-feedback' + (isError ? ' error' : '');
  clearTimeout(els.activateFeedback._timeout);
  els.activateFeedback._timeout = setTimeout(() => {
    els.activateFeedback.classList.add('fade');
  }, 3000);
}

function renderServerList() {
  els.serverList.innerHTML = '';
  for (const server of settings.servers) {
    els.serverList.appendChild(renderServerCard(server));
  }
}

function showEditForm(serverId = null) {
  editingServerId = serverId;
  els.editForm.hidden = false;
  els.testResult.textContent = '';

  if (serverId) {
    const server = settings.servers.find(s => s.id === serverId);
    els.editFormHeader.textContent = `Edit: ${server?.name || getHostname(server?.url)}`;
    els.serverNameInput.value = server?.name || '';
    els.serverUrlInput.value = server?.url || '';
    els.serverUsernameInput.value = server?.username || '';
    els.serverPasswordInput.value = '';
  } else {
    els.editFormHeader.textContent = 'New Server';
    els.serverNameInput.value = '';
    els.serverUrlInput.value = '';
    els.serverUsernameInput.value = '';
    els.serverPasswordInput.value = '';
  }

  els.serverUrlInput.focus();
  renderServerList();
}

function hideEditForm() {
  editingServerId = null;
  els.editForm.hidden = true;
  renderServerList();
}

async function handleDelete(serverId) {
  const server = settings.servers.find(s => s.id === serverId);
  if (!server) return;

  const isActive = serverId === settings.activeServerId;
  const isLast = settings.servers.length === 1;

  if (isActive && !isLast) {
    showSectionFeedback('Switch to another server first', true);
    return;
  }

  if (isActive && isLast) {
    const confirmed = await showConfirmDialog(
      'Delete the last server? You will need to add a new server to use SyncClipboard.'
    );
    if (!confirmed) return;
  }

  try {
    await storage.deleteServer(serverId);
    settings = await storage.getSettings();
    hideEditForm();
  } catch (err) {
    showSectionFeedback('Delete failed: ' + err.message, true);
  }
}

function showConfirmDialog(message) {
  return new Promise((resolve) => {
    if (els.deleteConfirmDialog.style.display === 'flex') {
      resolve(false);
      return;
    }

    els.deleteConfirmMessage.textContent = message;
    els.deleteConfirmDialog.style.display = 'flex';

    function cleanup() {
      els.deleteConfirmDialog.style.display = 'none';
      els.deleteConfirmYes.removeEventListener('click', onYes);
      els.deleteConfirmNo.removeEventListener('click', onNo);
    }

    function onYes() {
      cleanup();
      resolve(true);
    }

    function onNo() {
      cleanup();
      resolve(false);
    }

    els.deleteConfirmYes.addEventListener('click', onYes);
    els.deleteConfirmNo.addEventListener('click', onNo);
  });
}

els.addServerBtn.addEventListener('click', () => showEditForm(null));
els.cancelEditBtn.addEventListener('click', hideEditForm);

els.serverNameInput.addEventListener('input', clearResults);
els.serverUrlInput.addEventListener('input', clearResults);
els.serverUsernameInput.addEventListener('input', clearResults);
els.serverPasswordInput.addEventListener('input', clearResults);

els.testBtn.addEventListener('click', async () => {
  els.testBtn.disabled = true;
  els.testBtn.textContent = 'Testing...';
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';

  try {
    const url = els.serverUrlInput.value;
    const username = els.serverUsernameInput.value;
    let password = els.serverPasswordInput.value;
    if (!password && editingServerId) {
      password = await storage.getServerPassword(editingServerId);
    }
    const ok = await testConnection(url, username, password);
    els.testResult.textContent = ok ? 'Connected' : 'Failed';
    els.testResult.className = ok ? 'test-result ok' : 'test-result fail';
  } catch (err) {
    els.testResult.textContent = 'Failed: ' + err.message;
    els.testResult.className = 'test-result fail';
  } finally {
    els.testBtn.disabled = false;
    els.testBtn.textContent = 'Test Connection';
  }
});

els.saveServerBtn.addEventListener('click', async () => {
  els.saveServerBtn.disabled = true;
  els.saveServerBtn.textContent = 'Saving...';
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';

  let url = els.serverUrlInput.value.trim();
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
    els.serverUrlInput.value = url;
  }

  const serverData = {
    name: els.serverNameInput.value.trim() || getHostname(url),
    url,
    username: els.serverUsernameInput.value.trim(),
    password: els.serverPasswordInput.value
  };

  if (!serverData.url) {
    els.testResult.textContent = 'URL is required';
    els.testResult.className = 'test-result fail';
    els.saveServerBtn.disabled = false;
    els.saveServerBtn.textContent = 'Save';
    return;
  }
  if (!serverData.username) {
    els.testResult.textContent = 'Username is required';
    els.testResult.className = 'test-result fail';
    els.saveServerBtn.disabled = false;
    els.saveServerBtn.textContent = 'Save';
    return;
  }
  if (!editingServerId && !serverData.password) {
    els.testResult.textContent = 'Password is required';
    els.testResult.className = 'test-result fail';
    els.saveServerBtn.disabled = false;
    els.saveServerBtn.textContent = 'Save';
    return;
  }

  try {
    let savedServer;
    if (editingServerId) {
      const fields = { ...serverData };
      if (!fields.password) delete fields.password;
      savedServer = await storage.updateServer(editingServerId, fields);
    } else {
      savedServer = await storage.addServer(serverData);
    }
    settings = await storage.getSettings();
    if (!editingServerId && settings.servers.length === 1) {
      await storage.setActiveServer(savedServer.id);
    }
    hideEditForm();
  } catch (err) {
    els.testResult.textContent = 'Failed: ' + err.message;
    els.testResult.className = 'test-result fail';
  } finally {
    els.saveServerBtn.disabled = false;
    els.saveServerBtn.textContent = 'Save';
  }
});

function clearResults() {
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
  els.saveResult.textContent = '';
  els.saveResult.className = '';
}

els.maxSizeInput.addEventListener('input', clearResults);
els.historyCapacityInput.addEventListener('input', clearResults);

els.saveSettingsBtn.addEventListener('click', async () => {
  els.saveSettingsBtn.disabled = true;
  els.saveSettingsBtn.textContent = 'Saving...';
  els.saveResult.textContent = '';
  els.saveResult.className = '';
  els.historyCapacityError.textContent = '';
  els.maxSizeError.textContent = '';

  const rawCapacity = parseInt(els.historyCapacityInput.value);
  if (isNaN(rawCapacity) || rawCapacity < 1 || rawCapacity > 500) {
    els.historyCapacityError.textContent = 'Enter a number between 1 and 500';
    els.saveSettingsBtn.disabled = false;
    els.saveSettingsBtn.textContent = 'Save Settings';
    return;
  }

  const rawMaxSize = parseFloat(els.maxSizeInput.value);
  if (isNaN(rawMaxSize) || rawMaxSize < 1 || rawMaxSize > 1024) {
    els.maxSizeError.textContent = 'Enter a number between 1 and 1024';
    els.saveSettingsBtn.disabled = false;
    els.saveSettingsBtn.textContent = 'Save Settings';
    return;
  }

  try {
    await storage.setSettings({
      ...settings,
      maxFileSize: Math.round(parseFloat(els.maxSizeInput.value) * 1024 * 1024),
      historyCapacity: parseInt(els.historyCapacityInput.value)
    });

    const trimmed = await storage.trimHistory();
    settings = await storage.getSettings();
    if (trimmed > 0) {
      els.saveResult.textContent = `Saved — ${trimmed} old item${trimmed > 1 ? 's' : ''} removed`;
    } else {
      els.saveResult.textContent = 'Saved';
    }
    els.saveResult.className = 'save-success';
  } catch (err) {
    els.saveResult.textContent = 'Save failed: ' + err.message;
    els.saveResult.className = 'save-error';
  } finally {
    els.saveSettingsBtn.disabled = false;
    els.saveSettingsBtn.textContent = 'Save Settings';
  }
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadSettings() {
  await storage.runMigration();
  settings = await storage.getSettings();

  els.maxSizeInput.value = Math.round(settings.maxFileSize / (1024 * 1024));
  els.historyCapacityInput.value = settings.historyCapacity || 50;

  renderServerList();
}

loadSettings();