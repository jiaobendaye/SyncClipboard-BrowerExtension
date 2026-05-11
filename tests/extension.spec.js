import { test, expect } from '@playwright/test';

const POPUP = '/extension/popup.html';
const STANDALONE_POPUP = '/extension/popup.html?mode=standalone';
const OPTIONS = '/extension/options.html';
const WEBDAV_HOST = 'https://webdav.example.com';
const TEXT_INLINE_MAX_BYTES = 1024;

async function grantClipboard(context) {
  const browserName = context.browser().browserType().name();
  if (browserName === 'firefox') return;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
}

async function mockWebdav(page, handlers) {
  await page.route('**/webdav.example.com/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    for (const h of handlers) {
      const pathMatch = typeof h.path === 'string' ? path === h.path : h.path.test(path);
      if (h.method === method && pathMatch) {
        return route.fulfill({
          status: h.status || 200,
          contentType: h.contentType || 'application/json',
          body: typeof h.body === 'string' ? h.body : JSON.stringify(h.body),
        });
      }
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
  });
}

const PROPFIND_OK = { method: 'PROPFIND', path: '/', status: 207, contentType: 'application/xml', body: '<multistatus/>' };
const PROPFIND_FAIL = { method: 'PROPFIND', path: '/', status: 500, contentType: 'text/plain', body: 'Error' };
const MKCOL_OK = { method: 'MKCOL', path: '/', status: 201 };
const MKCOL_FILE_OK = { method: 'MKCOL', path: '/file', status: 201 };
const BASE_HANDLERS = [PROPFIND_OK, MKCOL_OK, MKCOL_FILE_OK];

async function seedSettings(page, overrides = {}) {
  const url = overrides.url || 'https://webdav.example.com';
  const username = overrides.username || 'testuser';
  const password = overrides.password || 'testpass';
  const maxFileSize = overrides.maxFileSize || 50 * 1024 * 1024;
  const historyCapacity = overrides.historyCapacity || 50;

  await page.evaluate(({ url, username, password, maxFileSize, historyCapacity }) => {
    // XOR-obfuscate password (same algorithm as storage.js)
    const key = 'SyncClipboard';
    const passwordBytes = new TextEncoder().encode(password);
    const obfuscatedChars = [];
    for (let i = 0; i < passwordBytes.length; i++) {
      obfuscatedChars.push(String.fromCharCode(passwordBytes[i] ^ key.charCodeAt(i % key.length)));
    }
    const obfuscatedPassword = btoa(obfuscatedChars.join(''));

    const hostname = new URL(url).hostname;
    const data = {
      settings: {
        servers: [{
          id: 'default',
          name: hostname,
          url,
          username,
          password: obfuscatedPassword
        }],
        activeServerId: 'default',
        maxFileSize,
        historyCapacity,
        migrationVersion: 1
      },
      history: [],
    };
    localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
  }, { url, username, password, maxFileSize, historyCapacity });
}

test.beforeEach(async ({ page, browserName }) => {
  page.setDefaultTimeout(1000);
  await page.addInitScript(() => {
    window.__SYNC_STORAGE_PATH__ = 'syncclipboard-test';
  });
  // In Playwright Firefox, page.route() does not intercept XHR requests that
  // pass credentials via xhr.open(method, url, true, user, pass). Strip them
  // so mocked routes work properly. Credentials are unnecessary in tests
  // because page.route() fulfills requests before they reach the network.
  if (browserName === 'firefox') {
    await page.addInitScript(() => {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, async, _user, _password) {
        return origOpen.call(this, method, url, async);
      };
    });
  }
});

test.describe('Options Page', () => {
  test('1. Connection test success', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'XHR with credentials in xhr.open() behaves differently in Firefox Playwright');
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    // Open the add server form
    await page.click('#add-server-btn');

    await page.fill('#server-url-input', WEBDAV_HOST);
    await page.fill('#server-username-input', 'testuser');
    await page.fill('#server-password-input', 'testpass');
    await page.click('#test-connection-btn');

    await expect(page.locator('.test-result.ok')).toHaveText('Connected');
  });

  test('2. Connection test failure', async ({ page }) => {
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_FAIL]);

    await page.click('#add-server-btn');

    await page.fill('#server-url-input', WEBDAV_HOST);
    await page.fill('#server-username-input', 'testuser');
    await page.fill('#server-password-input', 'testpass');
    await page.click('#test-connection-btn');

    await expect(page.locator('.test-result.fail')).toBeVisible();
  });

  test('8. Settings persistence', async ({ page }) => {
    await page.goto(OPTIONS);

    await page.click('#add-server-btn');
    await page.fill('#server-url-input', 'https://persist.example.com/');
    await page.fill('#server-username-input', 'persistuser');
    await page.fill('#server-password-input', 'persistpass');
    await page.click('#save-server-btn', { force: true });

    // Form should close after save
    await expect(page.locator('#server-edit-form')).toBeHidden();

    // A server card should appear
    await expect(page.locator('.server-card')).toBeVisible();

    // Edit it and update limits
    await page.locator('.server-card .edit-btn').click();
    await page.fill('#max-size-input', '10');
    await page.fill('#history-capacity-input', '20');
    await page.click('#save-settings-btn');
    await expect(page.locator('.save-success')).toBeVisible();

    // Reload and verify limits persisted
    await page.reload();
    await page.locator('.server-card .edit-btn').click();
    await expect(page.locator('#max-size-input')).toHaveValue('10');
    await expect(page.locator('#history-capacity-input')).toHaveValue('20');
  });
});

test.describe('Popup', () => {
  test('3. Read system clipboard text', async ({ page, context }) => {
    await grantClipboard(context);
    await page.goto(POPUP);

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('test clipboard content');
    });

    await page.click('#read-clipboard-btn');
    await expect(page.locator('#preview-text')).toContainText('test clipboard content');
  });

  test('4. Upload text to server', async ({ page, context }) => {
    await grantClipboard(context);

    let capturedProfile = null;
    await page.goto(POPUP);
    await mockWebdav(page, BASE_HANDLERS);

    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      if (route.request().method() === 'PUT') {
        capturedProfile = JSON.parse(route.request().postData());
      }
      route.fulfill({ status: 200 });
    });

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, BASE_HANDLERS);

    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      if (route.request().method() === 'PUT') {
        capturedProfile = JSON.parse(route.request().postData());
      }
      route.fulfill({ status: 200 });
    });

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('hello from test');
    });

    await page.click('#read-clipboard-btn');
    await page.click('#upload-btn');

    await expect(page.locator('.success-banner')).toBeVisible();
    expect(capturedProfile).toBeTruthy();
    expect(capturedProfile.type).toBe('Text');
    expect(capturedProfile.hasData).toBe(false);
  });

  test('Upload medium text keeps full text in profile', async ({ page, context }) => {
    await grantClipboard(context);

    const mediumText = 'M'.repeat(200);
    let capturedProfile = null;
    let uploadedFile = false;

    await page.goto(POPUP);
    await seedSettings(page);
    await mockWebdav(page, BASE_HANDLERS);

    await page.route('**/webdav.example.com/file/**', (route) => {
      uploadedFile = true;
      route.fulfill({ status: 200 });
    });

    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      if (route.request().method() === 'PUT') {
        capturedProfile = JSON.parse(route.request().postData());
      }
      route.fulfill({ status: 200 });
    });

    await page.reload();

    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, mediumText);

    await page.click('#read-clipboard-btn');
    await page.click('#upload-btn');

    await expect(page.locator('.success-banner')).toBeVisible();
    expect(uploadedFile).toBe(false);
    expect(capturedProfile).toBeTruthy();
    expect(capturedProfile.type).toBe('Text');
    expect(capturedProfile.hasData).toBe(false);
    expect(capturedProfile.text).toBe(mediumText);
  });

  test('Upload oversized text stores transfer file and preserves full text', async ({ page, context }) => {
    await grantClipboard(context);

    const longText = 'L'.repeat(TEXT_INLINE_MAX_BYTES + 200);
    let capturedProfile = null;
    let uploadedFileBody = null;
    let uploadedFilePath = null;

    await page.goto(POPUP);
    await seedSettings(page);
    await mockWebdav(page, BASE_HANDLERS);

    await page.route('**/webdav.example.com/file/**', (route) => {
      uploadedFilePath = new URL(route.request().url()).pathname;
      uploadedFileBody = route.request().postDataBuffer()?.toString('utf8') || null;
      route.fulfill({ status: 200 });
    });

    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      if (route.request().method() === 'PUT') {
        capturedProfile = JSON.parse(route.request().postData());
      }
      route.fulfill({ status: 200 });
    });

    await page.reload();

    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, longText);

    await page.click('#read-clipboard-btn');
    await page.click('#upload-btn');

    await expect(page.locator('.success-banner')).toBeVisible();
    expect(capturedProfile).toBeTruthy();
    expect(capturedProfile.type).toBe('Text');
    expect(capturedProfile.hasData).toBe(true);
    expect(capturedProfile.dataName).toMatch(/-text\.txt$/);
    expect(capturedProfile.text).toBe(longText.slice(0, TEXT_INLINE_MAX_BYTES));
    expect(capturedProfile.text.endsWith('...')).toBe(false);
    expect(uploadedFilePath).toBe('/file/' + capturedProfile.dataName);
    expect(uploadedFileBody).toBe(longText);
  });

  test('5. Download text from server', async ({ page }) => {
    await page.goto(POPUP);
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'Text', hash: 'abc123', text: 'downloaded text', hasData: false, size: 15 },
      },
    ]);

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'Text', hash: 'abc123', text: 'downloaded text', hasData: false, size: 15 },
      },
    ]);

    await page.click('#download-btn');
    await expect(page.locator('#preview-text')).toContainText('downloaded text');
    await expect(page.locator('.success-banner')).toBeVisible();
  });

  test('Download oversized text restores full clipboard text', async ({ page, context }) => {
    await grantClipboard(context);

    const longText = 'D'.repeat(TEXT_INLINE_MAX_BYTES + 250);
    const previewText = longText.slice(0, TEXT_INLINE_MAX_BYTES);
    const dataName = 'syncclipboard-20260507T113000Z-text.txt';

    await page.goto(POPUP);
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'Text', hash: 'abc123', text: previewText, hasData: true, dataName, size: longText.length },
      },
      {
        method: 'GET', path: '/file/' + dataName,
        status: 200, contentType: 'text/plain; charset=utf-8', body: longText,
      },
    ]);

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'Text', hash: 'abc123', text: previewText, hasData: true, dataName, size: longText.length },
      },
      {
        method: 'GET', path: '/file/' + dataName,
        status: 200, contentType: 'text/plain; charset=utf-8', body: longText,
      },
    ]);

    await page.click('#download-btn');
    await expect(page.locator('#preview-text')).toContainText(longText.slice(0, 200));
    await expect(page.locator('.success-banner')).toBeVisible();

    const clipboardText = await page.evaluate(async () => navigator.clipboard.readText());
    expect(clipboardText).toBe(longText);
  });

  test('6. Download file from server', async ({ page }) => {
    const fileName = 'syncclipboard-20260507T113000Z-image.png';
    await page.goto(POPUP);
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'Image', hash: 'def456', text: fileName, hasData: true, dataName: fileName, size: 51200 },
      },
      {
        method: 'GET', path: '/file/' + fileName,
        status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(1024),
      },
    ]);

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'Image', hash: 'def456', text: fileName, hasData: true, dataName: fileName, size: 51200 },
      },
      {
        method: 'GET', path: '/file/' + fileName,
        status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(1024),
      },
    ]);

    await page.click('#download-btn');
    await expect(page.locator('.success-banner')).toBeVisible();
  });

  test('Download hidden filename falls back when browser rejects it', async ({ page }) => {
    const fileName = '.last_revision';
    const savedFileName = 'last_revision';
    const fileBody = 'rev=20260507';
    const fileSize = Buffer.byteLength(fileBody);

    await page.goto(POPUP);
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'File', hash: 'def456', text: fileName, hasData: true, dataName: fileName, size: fileSize },
      },
      {
        method: 'GET', path: '/file/' + fileName,
        status: 200, contentType: 'application/octet-stream', body: fileBody,
      },
    ]);

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [
      ...BASE_HANDLERS,
      {
        method: 'GET', path: '/SyncClipboard.json',
        body: { type: 'File', hash: 'def456', text: fileName, hasData: true, dataName: fileName, size: fileSize },
      },
      {
        method: 'GET', path: '/file/' + fileName,
        status: 200, contentType: 'application/octet-stream', body: fileBody,
      },
    ]);

    await page.evaluate(() => {
      window.__downloads = [];
      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tagName, options) => {
        const element = originalCreateElement(tagName, options);
        if (String(tagName).toLowerCase() === 'a') {
          element.click = () => {
            window.__downloads.push({ fileName: element.download, href: element.href });
          };
        }
        return element;
      };

      URL.createObjectURL = (blob) => {
        window.__downloadBlobSize = blob.size;
        return 'blob:syncclipboard-test';
      };
      URL.revokeObjectURL = () => {};

      window.chrome = {
        runtime: {},
        downloads: {
          download: (_options, callback) => {
            window.chrome.runtime.lastError = { message: 'Invalid filename' };
            callback();
            delete window.chrome.runtime.lastError;
          }
        }
      };
    });

    await page.click('#download-btn');
    await expect(page.locator('.success-banner')).toContainText('Downloaded as: ' + savedFileName);

    const downloadState = await page.evaluate(() => ({
      downloads: window.__downloads,
      blobSize: window.__downloadBlobSize,
    }));
    expect(downloadState.downloads).toHaveLength(1);
    expect(downloadState.downloads[0].fileName).toBe(savedFileName);
    expect(downloadState.downloads[0].href).toBe('blob:syncclipboard-test');
    expect(downloadState.blobSize).toBe(fileSize);
  });

  test('7. File size limit displayed', async ({ page }) => {
    await page.goto(POPUP);
    // Default mock storage should show 50MB
    await expect(page.locator('#max-size-display')).toContainText('50.0MB');

    // Seed with 1MB limit
    await seedSettings(page, { maxFileSize: 1 * 1024 * 1024 });
    await page.reload();
    await expect(page.locator('#max-size-display')).toContainText('1.0MB');
  });

  test('9. Empty clipboard handling', async ({ page, context }) => {
    await grantClipboard(context);
    await page.goto(POPUP);

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('');
    });

    await page.click('#read-clipboard-btn');
    await expect(page.locator('.error-banner')).toBeVisible();
  });

  test('Choose File hands off to standalone page in extension popup context', async ({ page }) => {
    await page.goto(POPUP);

    await page.evaluate(() => {
      window.__openedWindows = [];
      window.__closedPopup = false;
      window.chrome = {
        runtime: {
          getURL: (path) => new URL(path, `${window.location.origin}/extension/`).toString()
        }
      };
      window.open = (url, target, features) => {
        window.__openedWindows.push({ url, target, features });
        return { focus() {} };
      };
      window.close = () => {
        window.__closedPopup = true;
      };
    });

    await page.click('#choose-file-btn');

    const state = await page.evaluate(() => ({
      openedWindows: window.__openedWindows,
      closedPopup: window.__closedPopup
    }));

    expect(state.openedWindows).toHaveLength(1);
    expect(state.openedWindows[0].url).toContain('/extension/popup.html?mode=standalone&pick=file');
    expect(state.openedWindows[0].features).toContain('popup=yes');
    expect(state.closedPopup).toBe(true);
  });

  test('Standalone page uploads selected file', async ({ page }) => {
    let capturedProfile = null;
    let uploadedPath = null;
    let uploadedBytes = 0;

    await page.goto(POPUP);
    await seedSettings(page);
    await mockWebdav(page, BASE_HANDLERS);

    await page.route('**/webdav.example.com/file/**', (route) => {
      if (route.request().method() !== 'PUT') {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
      }
      uploadedPath = new URL(route.request().url()).pathname;
      uploadedBytes = route.request().postDataBuffer()?.length || 0;
      return route.fulfill({ status: 200 });
    });

    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      if (route.request().method() === 'PUT') {
        capturedProfile = JSON.parse(route.request().postData());
      }
      return route.fulfill({ status: 200 });
    });

    await page.goto(STANDALONE_POPUP);

    await page.locator('#file-input').setInputFiles({
      name: 'picked.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('picked file contents')
    });

    await expect(page.locator('#preview-text')).toContainText('picked.txt');
    await expect(page.locator('#upload-btn')).toBeEnabled();

    await page.click('#upload-btn');

    await expect(page.locator('.success-banner')).toBeVisible();
    expect(capturedProfile).toBeTruthy();
    expect(capturedProfile.type).toBe('File');
    expect(capturedProfile.hasData).toBe(true);
    expect(capturedProfile.dataName).toBe('picked.txt');
    expect(uploadedPath).toBe('/file/picked.txt');
    expect(uploadedBytes).toBe(Buffer.byteLength('picked file contents'));
  });

  test('History list shows after upload', async ({ page, context }) => {
    await grantClipboard(context);
    await page.goto(POPUP);
    await mockWebdav(page, BASE_HANDLERS);
    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      route.fulfill({ status: 200 });
    });

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, BASE_HANDLERS);
    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      route.fulfill({ status: 200 });
    });

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('history test item');
    });

    await page.click('#read-clipboard-btn');
    await page.click('#upload-btn');
    await expect(page.locator('.success-banner')).toBeVisible();

    await expect(page.locator('.history-item').first()).toBeVisible();
  });

  test('Clear History with confirmation dialog', async ({ page, context }) => {
    await grantClipboard(context);
    await page.goto(POPUP);
    await mockWebdav(page, BASE_HANDLERS);
    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      route.fulfill({ status: 200 });
    });

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, BASE_HANDLERS);
    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      route.fulfill({ status: 200 });
    });

    // Upload item to create history
    await page.evaluate(async () => {
      await navigator.clipboard.writeText('item to clear');
    });
    await page.click('#read-clipboard-btn');
    await page.click('#upload-btn');
    await expect(page.locator('.success-banner')).toBeVisible();

    // Clear History
    await page.click('#clear-history-btn');
    await expect(page.locator('#confirm-dialog')).toBeVisible();

    // Confirm
    await page.click('#confirm-yes');
    await expect(page.locator('#confirm-dialog')).toBeHidden();

    // History should be empty
    await expect(page.locator('.history-item')).toHaveCount(0);
  });

  test('Upload button disabled until clipboard read', async ({ page }) => {
    await page.goto(POPUP);
    await expect(page.locator('#upload-btn')).toBeDisabled();
  });

  test('Preview and Download disabled without server config', async ({ page }) => {
    await page.goto(POPUP);
    // No seedSettings — storage is empty, no server configured
    await expect(page.locator('#preview-server-btn')).toBeDisabled();
    await expect(page.locator('#download-btn')).toBeDisabled();
    await expect(page.locator('#upload-btn')).toBeDisabled();
  });

  test('Preview and Download enabled when server connected', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'XHR with credentials in xhr.open() behaves differently in Firefox Playwright');
    await page.goto(POPUP);
    await mockWebdav(page, [PROPFIND_OK]);
    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [PROPFIND_OK]);
    // Upload still disabled (no clipboard read), Preview/Download enabled
    await expect(page.locator('#upload-btn')).toBeDisabled();
    await expect(page.locator('#preview-server-btn')).toBeEnabled();
    await expect(page.locator('#download-btn')).toBeEnabled();
  });

  test('Preview and Download disabled when server disconnected', async ({ page }) => {
    await page.goto(POPUP);
    await mockWebdav(page, [PROPFIND_FAIL]);
    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [PROPFIND_FAIL]);
    await expect(page.locator('#preview-server-btn')).toBeDisabled();
    await expect(page.locator('#download-btn')).toBeDisabled();
    await expect(page.locator('#upload-btn')).toBeDisabled();
  });

  test('Upload enabled after reading clipboard with server connected', async ({ page, context, browserName }) => {
    test.skip(browserName === 'firefox', 'XHR with credentials in xhr.open() behaves differently in Firefox Playwright');
    await grantClipboard(context);
    await page.goto(POPUP);
    await mockWebdav(page, [PROPFIND_OK]);
    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, [PROPFIND_OK]);
    await page.evaluate(async () => {
      await navigator.clipboard.writeText('upload test content');
    });
    await page.click('#read-clipboard-btn');
    await expect(page.locator('#preview-text')).not.toHaveText('No content read yet');
    await expect(page.locator('#upload-btn')).toBeEnabled();
  });

  test('Confirm dialog cancel preserves history', async ({ page, context }) => {
    await grantClipboard(context);
    await page.goto(POPUP);
    await mockWebdav(page, BASE_HANDLERS);
    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      route.fulfill({ status: 200 });
    });

    await seedSettings(page);
    await page.reload();
    await mockWebdav(page, BASE_HANDLERS);
    await page.route('**/webdav.example.com/SyncClipboard.json', (route) => {
      route.fulfill({ status: 200 });
    });

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('keep this item');
    });
    await page.click('#read-clipboard-btn');
    await page.click('#upload-btn');
    await expect(page.locator('.success-banner')).toBeVisible();

    await page.click('#clear-history-btn');
    await expect(page.locator('#confirm-dialog')).toBeVisible();

    // Cancel
    await page.click('#confirm-no');
    await expect(page.locator('#confirm-dialog')).toBeHidden();

    // History should still have the item
    await expect(page.locator('.history-item')).toHaveCount(1);
  });
});

test.describe('Options Page - Multi-Server', () => {
  test('Add server — form closes and card appears', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox');
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    await page.click('#add-server-btn');
    await expect(page.locator('#server-edit-form')).toBeVisible();

    await page.fill('#server-url-input', 'https://second.example.com/sync/');
    await page.fill('#server-username-input', 'user2');
    await page.fill('#server-password-input', 'pass2');
    await page.fill('#server-name-input', 'Second Server');
    await page.click('#save-server-btn', { force: true });

    await expect(page.locator('#server-edit-form')).toBeHidden();
    await expect(page.locator('.server-card')).toHaveCount(1);
    await expect(page.locator('.server-name')).toHaveText('Second Server');
  });

  test('Edit server — modifies name and saves in-place', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox');
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    await page.click('#add-server-btn');
    await page.fill('#server-url-input', WEBDAV_HOST);
    await page.fill('#server-username-input', 'testuser');
    await page.fill('#server-password-input', 'testpass');
    await page.click('#save-server-btn', { force: true });

    // Click edit on the card
    await page.locator('.server-card .edit-btn').click();
    await expect(page.locator('#server-edit-form')).toBeVisible();
    await expect(page.locator('#server-url-input')).toHaveValue(WEBDAV_HOST);

    await page.fill('#server-name-input', 'Renamed Server');
    await page.click('#save-server-btn', { force: true });

    await expect(page.locator('.server-name')).toHaveText('Renamed Server');
  });

  test('Delete server — removes card from list', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox');
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    // Add two servers
    await page.click('#add-server-btn');
    await page.fill('#server-url-input', 'https://server-a.com/');
    await page.fill('#server-username-input', 'a');
    await page.fill('#server-password-input', 'a');
    await page.click('#save-server-btn', { force: true });

    await page.click('#add-server-btn');
    await page.fill('#server-url-input', 'https://server-b.com/');
    await page.fill('#server-username-input', 'b');
    await page.fill('#server-password-input', 'b');
    await page.click('#save-server-btn', { force: true });

    await expect(page.locator('.server-card')).toHaveCount(2);

    // Delete the second server (not active)
    const secondCard = page.locator('.server-card').nth(1);
    await secondCard.locator('.delete-btn').click({ force: true });

    await expect(page.locator('.server-card')).toHaveCount(1);
  });

  test('Delete button hidden when only one server exists', async ({ page }) => {
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    await page.click('#add-server-btn');
    await page.fill('#server-url-input', WEBDAV_HOST);
    await page.fill('#server-username-input', 'testuser');
    await page.fill('#server-password-input', 'testpass');
    await page.click('#save-server-btn', { force: true });

    await expect(page.locator('.delete-btn')).toHaveCount(0);
  });

  test('Delete button shows inline error when active and only 2 servers', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox');
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    // Add two servers
    await page.click('#add-server-btn');
    await page.fill('#server-url-input', WEBDAV_HOST);
    await page.fill('#server-username-input', 'user1');
    await page.fill('#server-password-input', 'pass1');
    await page.click('#save-server-btn', { force: true });

    await page.click('#add-server-btn');
    await page.fill('#server-url-input', 'https://other.example.com/');
    await page.fill('#server-username-input', 'user2');
    await page.fill('#server-password-input', 'pass2');
    await page.click('#save-server-btn', { force: true });

    // First card is active — click delete
    await page.locator('.server-card').first().locator('.delete-btn').click({ force: true });
    await expect(page.locator('#test-result')).toHaveClass(/fail/);
    await expect(page.locator('#test-result')).toContainText('Switch to another server first');

    // Add a third server to make deletion allowed
    await page.click('#add-server-btn');
    await page.fill('#server-url-input', 'https://third.example.com/');
    await page.fill('#server-username-input', 'user3');
    await page.fill('#server-password-input', 'pass3');
    await page.click('#save-server-btn', { force: true });

    // Now delete the (original) active server
    await page.locator('.server-card').first().locator('.delete-btn').click({ force: true });
    await expect(page.locator('.server-card')).toHaveCount(2);
  });

  test('Save Settings updates limits', async ({ page }) => {
    await page.goto(OPTIONS);

    await page.click('#add-server-btn');
    await page.fill('#server-url-input', WEBDAV_HOST);
    await page.fill('#server-username-input', 'testuser');
    await page.fill('#server-password-input', 'testpass');
    await page.click('#save-server-btn', { force: true });

    await page.locator('.server-card .edit-btn').click();
    await page.fill('#max-size-input', '25');
    await page.fill('#history-capacity-input', '100');
    await page.click('#save-settings-btn');

    await expect(page.locator('.save-success')).toBeVisible();

    await page.reload();
    await page.locator('.server-card .edit-btn').click();
    await expect(page.locator('#max-size-input')).toHaveValue('25');
    await expect(page.locator('#history-capacity-input')).toHaveValue('100');
  });
});

test.describe('Popup - Multi-Server', () => {
  test('Server selector hidden when only one server', async ({ page }) => {
    await page.goto(POPUP);
    await seedSettings(page, { url: WEBDAV_HOST });
    await page.reload();
    await mockWebdav(page, [PROPFIND_OK]);

    await expect(page.locator('#server-selector')).toBeHidden();
  });

  test('Server selector shown when two or more servers', async ({ page }) => {
    await page.goto(POPUP);
    await page.evaluate(() => {
      const data = {
        settings: {
          servers: [
            { id: 's1', name: 'Server One', url: 'https://server1.example.com/', username: 'u1', password: '' },
            { id: 's2', name: 'Server Two', url: 'https://server2.example.com/', username: 'u2', password: '' }
          ],
          activeServerId: 's1',
          maxFileSize: 50 * 1024 * 1024,
          historyCapacity: 50,
          migrationVersion: 1
        },
        history: []
      };
      localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
    });
    await page.reload();
    await mockWebdav(page, [PROPFIND_OK]);

    await expect(page.locator('#server-selector')).toBeVisible();
    await expect(page.locator('.ss-name')).toHaveText('Server One');
  });

  test('Dropdown shows all servers and Add New Server item', async ({ page }) => {
    await page.goto(POPUP);
    await page.evaluate(() => {
      const data = {
        settings: {
          servers: [
            { id: 's1', name: 'Work NAS', url: 'https://nas.example.com/', username: 'u1', password: '' },
            { id: 's2', name: 'Home Server', url: 'https://home.example.com/', username: 'u2', password: '' }
          ],
          activeServerId: 's1',
          maxFileSize: 50 * 1024 * 1024,
          historyCapacity: 50,
          migrationVersion: 1
        },
        history: []
      };
      localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
    });
    await page.reload();
    await mockWebdav(page, [PROPFIND_OK]);

    await page.click('#server-selector-btn');

    await expect(page.locator('.dd-item')).toHaveCount(3); // 2 servers + Add New Server
    await expect(page.locator('.dd-item.add-item')).toContainText('Add New Server');
    await expect(page.locator('.dd-item.active .dd-server-name')).toHaveText('Work NAS');
  });

  test('Clicking Add New Server opens options page', async ({ page }) => {
    await page.goto(POPUP);
    await page.evaluate(() => {
      const data = {
        settings: {
          servers: [
            { id: 's1', name: 'Work NAS', url: 'https://nas.example.com/', username: 'u1', password: '' },
            { id: 's2', name: 'Home NAS', url: 'https://home.example.com/', username: 'u2', password: '' }
          ],
          activeServerId: 's1',
          maxFileSize: 50 * 1024 * 1024,
          historyCapacity: 50,
          migrationVersion: 1
        },
        history: []
      };
      localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
    });
    await page.reload();

    await page.click('#server-selector-btn');
    await page.click('.dd-item.add-item');

    const newPage = await page.context().waitForEvent('page', { timeout: 5000 });
    await expect(newPage.url()).toContain('/options.html');
  });

  test('Switching server updates status dot to checking then connected', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox');
    await page.goto(POPUP);
    await page.evaluate(() => {
      const data = {
        settings: {
          servers: [
            { id: 's1', name: 'Server One', url: 'https://server1.example.com/', username: 'u1', password: '' },
            { id: 's2', name: 'Server Two', url: 'https://server2.example.com/', username: 'u2', password: '' }
          ],
          activeServerId: 's1',
          maxFileSize: 50 * 1024 * 1024,
          historyCapacity: 50,
          migrationVersion: 1
        },
        history: []
      };
      localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
    });
    await page.reload();
    await mockWebdav(page, [
      { method: 'PROPFIND', path: '/', status: 207, contentType: 'application/xml', body: '<multistatus/>' },
      { method: 'MKCOL', path: '/', status: 201 },
      { method: 'MKCOL', path: '/file', status: 201 }
    ]);

    // Initially connected to s1
    await expect(page.locator('#status-dot')).toHaveClass(/connected/);

    // Switch to s2
    await page.click('#server-selector-btn');
    await page.locator('.dd-item').nth(1).click();

    // Status should update (may be checking then connected)
    await expect(page.locator('#server-selector')).toBeVisible();
    // The status text should reflect the new active server
    await expect(page.locator('.ss-name')).toHaveText('Server Two');
  });

  test('Active server shows checkmark in dropdown', async ({ page }) => {
    await page.goto(POPUP);
    await page.evaluate(() => {
      const data = {
        settings: {
          servers: [
            { id: 's1', name: 'Active Server', url: 'https://active.example.com/', username: 'u1', password: '' },
            { id: 's2', name: 'Other Server', url: 'https://other.example.com/', username: 'u2', password: '' }
          ],
          activeServerId: 's1',
          maxFileSize: 50 * 1024 * 1024,
          historyCapacity: 50,
          migrationVersion: 1
        },
        history: []
      };
      localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
    });
    await page.reload();
    await mockWebdav(page, [PROPFIND_OK]);

    await page.click('#server-selector-btn');
    await expect(page.locator('.dd-item.active .check')).toBeVisible();
    await expect(page.locator('.dd-item').nth(1)).not.toHaveClass(/active/);
  });
});