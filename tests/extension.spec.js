import { test, expect } from '@playwright/test';

const POPUP = '/extension/popup.html';
const STANDALONE_POPUP = '/extension/popup.html?mode=standalone';
const OPTIONS = '/extension/options.html';
const WEBDAV_HOST = 'https://webdav.example.com';
const TEXT_INLINE_MAX_BYTES = 1024;

/**
 * Install mock WebDAV routes on the page.
 * Routes persist for the page lifetime. Call after page.goto but before interactions.
 */
async function mockWebdav(page, handlers) {
  // Route ALL requests to the WebDAV host
  await page.route('**/webdav.example.com/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    for (const h of handlers) {
      // Support both exact path match and string prefix
      const pathMatch = typeof h.path === 'string' ? path === h.path : h.path.test(path);
      if (h.method === method && pathMatch) {
        return route.fulfill({
          status: h.status || 200,
          contentType: h.contentType || 'application/json',
          body: typeof h.body === 'string' ? h.body : JSON.stringify(h.body),
        });
      }
    }

    // Default: 404
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
  });
}

// Shared WebDAV handler sets for reuse
const PROPFIND_OK = { method: 'PROPFIND', path: '/', status: 207, contentType: 'application/xml', body: '<multistatus/>' };
const PROPFIND_FAIL = { method: 'PROPFIND', path: '/', status: 500, contentType: 'text/plain', body: 'Error' };
const MKCOL_OK = { method: 'MKCOL', path: '/', status: 201 };
const MKCOL_FILE_OK = { method: 'MKCOL', path: '/file', status: 201 };

// Common handlers needed by most popup tests
const BASE_HANDLERS = [PROPFIND_OK, MKCOL_OK, MKCOL_FILE_OK];

/**
 * Save settings directly into mock storage via evaluate.
 * Faster and more reliable than filling the options form for every test.
 */
async function seedSettings(page, overrides = {}) {
  await page.evaluate((opts) => {
    const data = {
      settings: {
        webdav: { url: opts.url || 'https://webdav.example.com', username: opts.username || 'testuser' },
        maxFileSize: opts.maxFileSize || 50 * 1024 * 1024,
      },
      password: opts.password || 'testpass',
      history: [],
    };
    localStorage.setItem(window.__SYNC_STORAGE_PATH__, JSON.stringify(data));
  }, overrides);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__SYNC_STORAGE_PATH__ = 'syncclipboard-test';
  });
});

test.describe('Options Page', () => {
  test('1. Connection test success', async ({ page }) => {
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_OK]);

    await page.fill('#webdav-url', WEBDAV_HOST);
    await page.fill('#webdav-username', 'testuser');
    await page.fill('#webdav-password', 'testpass');
    await page.click('#test-connection-btn');

    await expect(page.locator('#test-result.success')).toHaveText('Connected');
  });

  test('2. Connection test failure', async ({ page }) => {
    await page.goto(OPTIONS);
    await mockWebdav(page, [PROPFIND_FAIL]);

    await page.fill('#webdav-url', WEBDAV_HOST);
    await page.fill('#webdav-username', 'testuser');
    await page.fill('#webdav-password', 'testpass');
    await page.click('#test-connection-btn');

    await expect(page.locator('#test-result.error')).toBeVisible();
  });

  test('8. Settings persistence', async ({ page }) => {
    await page.goto(OPTIONS);

    await page.fill('#webdav-url', 'https://persist.example.com/');
    await page.fill('#webdav-username', 'persistuser');
    await page.fill('#max-size-input', '10');
    await page.click('#save-btn');
    await expect(page.locator('#save-result.success')).toBeVisible();

    // Reload and verify settings are restored
    await page.reload();
    await expect(page.locator('#webdav-url')).toHaveValue('https://persist.example.com/');
    await expect(page.locator('#webdav-username')).toHaveValue('persistuser');
    await expect(page.locator('#max-size-input')).toHaveValue('10');
  });
});

test.describe('Popup', () => {
  test('3. Read system clipboard text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(POPUP);

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('test clipboard content');
    });

    await page.click('#read-clipboard-btn');
    await expect(page.locator('#preview-text')).toContainText('test clipboard content');
  });

  test('4. Upload text to server', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

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
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

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
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

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
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

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
    // In non-extension context, file downloads via temporary anchor element
    await expect(page.locator('.success-banner')).toBeVisible();
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
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

  test('Confirm dialog cancel preserves history', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
