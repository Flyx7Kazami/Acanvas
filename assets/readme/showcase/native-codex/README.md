# Native Codex showcase adapter

This adapter runs the installed Codex renderer with synthetic Slow Signal data. It renders the application's own React components, CSS, fonts, icons, conversation view, sidebar, and browser controls. Acanvas runs in the renderer's original native `webview` element.

The repository contains the adapter and fictional data. The application bundle stays in a temporary directory on the machine that produces the image.

## Run

Requires macOS, Node 24, npm, an installed Codex app, and a dedicated Acanvas example project. Start the example project, then set `SHOWCASE_CANVAS_URL` and `SHOWCASE_PREVIEW_ORIGIN` to the URLs issued by that dedicated service.

```sh
node assets/readme/showcase/native-codex/run.mjs \
  --codex-app /Applications/ChatGPT.app \
  --canvas-url "$SHOWCASE_CANVAS_URL" \
  --preview-origin "$SHOWCASE_PREVIEW_ORIGIN"
```

Use the URLs issued by the dedicated example service. The command creates a fresh temporary workspace, copies the installed renderer there, declares and installs its matching official Electron runtime, and opens **Slow Signal — Acanvas Showcase**. Closing the window stops that run's renderer server. Temporary source files remain available for inspection.

## Boundaries

- Original JavaScript, CSS, fonts, icons, and HTML are copied byte for byte. The served HTML points its existing module entry to the adapter; the adapter then imports the original module. The original CSP is preserved.
- Synthetic data replaces the external boundaries: Electron bridge messages, host RPC services, worker replies, settings, conversation history, and HTTP responses. No component markup or styling is recreated.
- The native primary window uses the installed main process's `hiddenInset` titlebar configuration. The original browser host creates its original `webview`; the temporary Electron host loads the dedicated Acanvas example into it. The original Reload page action passes through an isolated preload IPC method to that registered webview's native reload.
- Each run has separate Electron user data and browser partitions. HTTP and WebSocket requests are restricted to the temporary renderer, the dedicated Acanvas origin, and its explicitly supplied preview origin. External HTTP service requests receive local synthetic responses. Permission requests are declined.
- No real Codex conversation, account, credentials, profile, or host storage is read. The installed app is unchanged. The adapter does not run an agent, deliver requests, or submit Acanvas queue items.

The RPC symbol lookup in `prepare.mjs` follows the renderer observed in Codex **26.1007.30912**, build **20156**, Electron **42.3.0**. A later application build may need an adapter update. Each extraction writes its actual source metadata and byte-copy result to the temporary `source.json`.

## Validation

The original renderer was exercised in the isolated Electron window through Computer Use: Codex mode, fictional two-turn conversation, native pane resizing, native browser controls, the original Reload page button's IPC-to-webview reload, and the real Acanvas example. Reload read back the example's saved 37% camera while preserving the 831.05 × 798 native viewport. Source extraction was reproduced separately; all 20,119 copied renderer files matched their source bytes. The original RPC implementation was also exercised with a streamed synthetic HTTP response.

The final Acanvas camera, layout, assets, interaction checks, and exported screenshot are recorded by the showcase workflow. They can change independently of this host adapter.
