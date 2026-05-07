# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Unit tests (node --test)
npm run test:unit

# E2E tests (Playwright, auto-starts dev server on :8765)
npm run test
npm run test:headed    # headed mode for debugging

# Package extension for distribution
cd extension && zip -r ../syncclipboard-extension.zip .
```

## Architecture

This is a **zero-build** Chrome Extension (Manifest V3). All JS files are plain ES modules loaded directly by Chrome — no bundler, no transpiler.

### Storage Provider Pattern

`storage.js` and `storage-mock.js` implement the same `StorageProvider` interface. Modules auto-select at import time:

```js
const storage = (typeof chrome !== 'undefined' && chrome.storage)
  ? createChromeStorage()   // chrome.storage.session + chrome.storage.local
  : createMockStorage()      // localStorage or in-memory (Playwright/Node.js)
```

- **Settings** (URL, username, maxFileSize, historyCapacity) → `chrome.storage.local` (persistent)
- **Password** → `chrome.storage.session` (cleared when browser closes)
- **History** → `chrome.storage.local`

### WebDAV Client (`webdav-client.js`)

Zero-dependency client. Three notable implementation details:

1. **`testConnection` uses XHR, not fetch.** `xhr.open(method, url, true, username, password)` passes credentials as open() params so Chrome doesn't show a native auth dialog on 401. All other functions use `fetch()` via the shared `request()` helper.

2. **Hash algorithm matches Reference implementations exactly**: `SHA256(fileName + "|" + SHA256(blob).toUpperCase()).toUpperCase()` for file-backed content, `SHA256(text).toUpperCase()` for inline text. Must be uppercase hex.

3. **ProfileDto uses camelCase** (not PascalCase) to match the Reference mobile/TypeScript client wire format.

### E2E Test Architecture

Playwright tests use `page.route()` to intercept all requests to `webdav.example.com` and return mock responses. `page.addInitScript` sets `window.__SYNC_STORAGE_PATH__` so mock storage uses a known localStorage key. `seedSettings()` writes settings directly into mock storage via `page.evaluate()` — faster than filling the options form for every test.

### Key URLs and Paths

- Popup: `popup.html` (extension action)
- Options/Settings: `options.html` (extension options page)
- WebDAV profile: `{baseUrl}/SyncClipboard.json`
- WebDAV files: `{baseUrl}/file/{encodedFileName}`

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

### Available skills

`/office-hours` `/plan-ceo-review` `/plan-eng-review` `/plan-design-review` `/design-consultation` `/design-shotgun` `/design-html` `/review` `/ship` `/land-and-deploy` `/canary` `/benchmark` `/browse` `/connect-chrome` `/qa` `/qa-only` `/design-review` `/setup-browser-cookies` `/setup-deploy` `/setup-gbrain` `/retro` `/investigate` `/document-release` `/codex` `/cso` `/autoplan` `/plan-devex-review` `/devex-review` `/careful` `/freeze` `/guard` `/unfreeze` `/gstack-upgrade` `/learn`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
