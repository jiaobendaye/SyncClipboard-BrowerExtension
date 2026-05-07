import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: {
    baseURL: 'http://localhost:8765',
    headless: true,
  },
  webServer: {
    command: 'python3 -m http.server 8765',
    url: 'http://localhost:8765/extension/popup.html',
    cwd: '.',
    reuseExistingServer: true,
  },
});
