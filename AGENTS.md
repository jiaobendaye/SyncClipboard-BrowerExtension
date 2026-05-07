# Repository Guidelines

## Project Structure & Module Organization

`extension/` contains the browser extension source: `popup.*` for the action UI, `options.*` for settings, `webdav-client.js` for protocol logic, `browser-api.js` for Chrome/Firefox API normalization, and `storage*.js` for persistence. Static assets live under `extension/icons/`. Protocol notes live in `docs/protocol.md`. End-to-end tests are in `tests/extension.spec.js`; focused protocol unit tests are in `tests/unit/webdav-client.test.js`.

## Build, Test, and Development Commands

There is no bundling step; the extension is loaded directly from `extension/`.

- `npm test` runs the Chromium Playwright suite.
- `npm run test:firefox` runs the Firefox Playwright suite.
- `npm run test:headed` runs Playwright with a visible browser window.
- `npm run test:unit` runs Node’s built-in unit tests for protocol logic.
- `npx playwright install chromium firefox` installs browsers for first-time test runs.

For manual development, load `extension/` in `chrome://extensions` or `about:debugging`.

## Coding Style & Naming Conventions

Use ES modules, 2-space indentation, single quotes, and the existing semicolon-free style. Prefer small functions with explicit names such as `getProfile`, `putFileData`, and `grantClipboard`. Use `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for module constants, and keep filenames lowercase with hyphens only where already established. Preserve the current zero-dependency approach in extension runtime code.

## Testing Guidelines

Add or update tests for every behavior change. Put browser workflow coverage in `tests/extension.spec.js` and protocol-only coverage in `tests/unit/webdav-client.test.js`. Name tests by behavior, for example `Download hidden filename falls back when browser rejects it`. When changing cross-browser behavior, run both `npm test` and `npm run test:firefox`.

## Commit & Pull Request Guidelines

Recent history uses short, imperative commit messages such as `fix choose file on non-macos` and `Fix cross-browser downloads and Playwright tests`. Follow that pattern: concise subject, no noise. PRs should describe the user-visible change, list commands run, and call out browser coverage. Include screenshots for popup/options UI changes and update `docs/protocol.md` when protocol or wire-format behavior changes.

## Security & Configuration Tips

Do not hardcode credentials in tests or source. WebDAV settings are user-provided; keep examples on `webdav.example.com`. If you touch download behavior, verify both filename compatibility and fallback paths in Chromium and Firefox.
