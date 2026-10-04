# HTML preview execution validation

Date: 2026-10-04. All project roots, parent pages, HTML documents and network sinks were created for these tests. The production service and whiteboard were kept untouched.

## Protocol and boundaries

- Authenticated `POST /api/assets/:assetId/html-preview` returns `201 { id, url, origin, expiresAt }` for one HTML asset. Authenticated `DELETE /api/html-previews/:id` returns `200 { revoked: true }`.
- The preview listener uses a random loopback port. A `127.0.0.1` parent receives a `localhost` preview; a `localhost` parent receives a `127.0.0.1` preview. Grants bind that exact preview Host and parent origin. This separates the main cookie host without modifying system aliases.
- The main HTML response contains `meta[name=acanvas-html-preview-origin]` and a CSP `frame-src` with the same exact preview origin. A service restart revokes grants and returns current metadata with the new response.
- The preview route accepts iframe navigations only. Top-level access returns `403`. It provides inline HTML/CSS/JavaScript and data images under response `sandbox allow-scripts`, with an opaque origin and a parent-specific `frame-ancestors` policy. Original HTML remains an attachment download through the main authenticated content API.
- Grants expire after ten minutes and are cleared when the main service closes. HTML preview loads support up to 10 MiB; larger originals remain downloadable. Removing the iframe ends a running instance; revoking a URL alone does not stop JavaScript already loaded in a document.
- The bridge sends only `acanvas:preview-ready` and Escape-triggered `acanvas:preview-exit`, each with the grant's `instanceId`, to its fixed parent origin. The frontend validates current frame source, opaque message origin, instance ID and message type.

## Executed checks

```sh
npm run build:server
.runtime/node_modules/node/bin/node --test dist/tests/html-preview.test.js dist/tests/server.test.js dist/tests/cookie-isolation.test.js
npm run test:browser -- --config tests/html-preview-security.config.ts --output=/private/tmp/acanvas-html-security-final-20261004-2222
```

Server build passed. Node tests: **31/31 passed, 3.36 seconds, exit 0** (five new HTML/content tests, 23 existing server tests and three existing cookie tests). Chrome security tests: **3/3 passed, 4.4 seconds, exit 0**.

| Scope | Actual result |
| --- | --- |
| Upload MIME normalization, safe audio MIME and Range, raw HTML downloads | Passed |
| Main bearer/cookie/Host/Origin boundaries, per-asset grant, expiry, explicit revocation and service restart | Passed |
| Same-response metadata/CSP and both loopback parent hostnames | Passed |
| Whole-file Markdown/HTML/audio targets, audio/video time, audio snapshot rejection | Passed |
| Historical task target reuse by exact identity and fields; new, changed and borrowed targets | Exact historical target preserved; new/changed/borrowed targets rejected |
| Inline script button, current-frame ready and Escape exit | Passed |
| Parent DOM/storage, opaque-origin cookies, main API read/write, local files, external fetch/image, forms, popup, download and top navigation | Blocked in the real browser |
| External iframe self-navigation | Parent CSP blocked it into a Chrome error document; the test sink received zero requests |
| Preview URL opened in a top-level tab | `403`, imported script did not execute |
| External Stop during one synchronous infinite loop | Removed the iframe in **27.17 ms** with standard Chrome-channel security flags |

## Measurement limits

The initial infinite-loop run used Playwright tracing. Its child-frame snapshot instrumentation stalled before the Stop action and timed out after 30 seconds. The final loop project disables tracing and uses a Node delay before clicking the actual parent Stop control; the two boundary projects retain failure tracing. Browser isolation flags were kept at the normal Chrome-channel defaults. The installed Playwright 1.55.1 launch switches contain no flag disabling `IsolateOrigins` or `site-per-process`.

The 27.17 ms result covers one specific loop in the tested Chrome browser. Sandbox and CSP express permissions and resource channels; they provide no general CPU or memory quota. This run does not establish runaway-script behavior for Codex's in-app browser, Safari, low-memory conditions or every possible workload.

## Evidence

- [Working isolated script and external controls](html-isolated-script-and-external-controls.png)
- [Stop measurement](html-stop-responsiveness.json)

Fixtures and test browsers were closed after the final runs. The initial test failures remain under `/private/tmp/acanvas-html-security-20261004-2210` for diagnosis; successful final evidence is copied here. Product source, tests and evidence remain uncommitted for independent review.
