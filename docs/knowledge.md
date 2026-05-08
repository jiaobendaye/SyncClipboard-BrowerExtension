# Project Knowledge

Auto-generated from gstack learnings. 5 entries.

## XHR open() credentials suppresses native auth dialog

Tags: webdav, xhr, auth, browser-api

When connecting to WebDAV servers that return 401 with WWW-Authenticate: Basic, using fetch() with an Authorization header still triggers the browser's native auth dialog. The fix: use XMLHttpRequest with credentials passed as the 4th and 5th arguments to xhr.open(method, url, true, username, password). This tells Chrome that credentials were already provided by the extension, so it won't prompt the user. The testConnection function already used this pattern; the fix was migrating the general request() helper from fetch to XHR.

## serverConnected flag must be set after async testConnection

Tags: popup, connection, state-management, race-condition

The serverConnected boolean controls whether Upload/Download/Preview buttons are enabled. It must be set to the result of testConnection() AFTER the async call resolves — setting it to true before the await means the flag stays true even when the connection fails. Always: const ok = await testConnection(...); serverConnected = ok. Also set serverConnected = false in the catch block and the no-URL early return path.

## Unified button state with updateActionButtons + serverConnected

Tags: popup, buttons, state-management, pattern, refactoring

Use a single updateActionButtons() function as the one source of truth for the three server-dependent action buttons (Upload, Download, Preview Server). It reads the module-level serverConnected and clipboardContent flags directly, so callers never need to compute button state themselves. uploadBtn = !serverConnected || !clipboardContent, downloadBtn/previewServerBtn = !serverConnected. checkConnection() only sets serverConnected then calls updateActionButtons() — no direct DOM manipulation. Any code that changes clipboardContent calls updateActionButtons() immediately after. setButtons(enabled) handles only force-disable during async operations; on restore it delegates to updateActionButtons().

## putProfile ensureDir('/') is an unnecessary network round-trip

Tags: webdav, performance, network

putProfile was calling ensureDir('/') before every PUT, sending an MKCOL for the root directory. The root directory always exists — this was a wasted round-trip. Removing it cut putProfile latency. Similarly, ensureDir for /file/ can be skipped; the PUT/GET to a path under /file/ will fail with a clear error if the directory doesn't exist, and it will exist after the first successful upload.

## XHR needs explicit Authorization header to avoid 401 round-trip

Tags: webdav, xhr, auth, performance

xhr.open(method, url, true, user, pass) tells Chrome credentials were provided (suppressing the native auth dialog), but the browser does NOT send the Authorization header on the first request. It waits for a 401 + WWW-Authenticate challenge, then retries — doubling latency for every authenticated request. Fix: also call xhr.setRequestHeader('Authorization', 'Basic ' + base64Encode(user + ':' + pass)) to send auth on the first request. Keep both: open() credentials suppress the dialog if auth fails, the explicit header avoids the 401 in the common case.
