# acanvas

A local, project-based creative whiteboard for collaborating with agents through a shared Agent Skill. Agents use the same CLI and local service; host conversation binding is an optional way to resolve a task scope.

Import images, video, audio, and documents, select materials, and add annotations. Send references and instructions to a request queue in an explicit session. Agents process requests through the CLI, use their existing creative tools, and publish results back to the shared canvas.

## Status

The runnable P0 prototype includes a full-screen canvas, floating controls, an adaptive composer, an expandable request queue, material imports and annotations, host conversation binding, and a persistent local service. The latest multimodal interactions support direct document interaction, eight-point resizing, embedded audio artwork, and a compact player with a complete audio waveform.

Chatbox references appear inline with the text, with a separate preview for each selected material and object/task search. Point markers stay at the clicked position. Point and region annotations save the open page's displayed whiteboard pixels in the background. Task history reads the saved scene.

Select multiple items to create a group frame. Store it in a solid-color folder with three item previews and an archive grid, then click the cover to edit its contents on a second board. Click the folder name or item count to select its members for a request. Back restores the main board view. Switching modes moves neighboring items to use the available space, and Ungroup keeps the original items.

- [Project plan](docs/PLAN.md): requirements, architecture, implementation stages, and acceptance criteria.
- [Frontend design](docs/FRONTEND.md): visual references, grayscale themes, and interaction rules.
- [Multimodal canvas design](docs/MULTIMODAL_CANVAS_DESIGN.md): content types, references, and preview boundaries.
- [Validation record](docs/VALIDATION.md): verified behavior and remaining limitations.
- [Item groups and folders](docs/ITEM_GROUPS_DESIGN.md): interaction, layout and persistence; [validation](docs/ITEM_GROUPS_VALIDATION.md).
- [Chatbox capture foundation](docs/chatbox/CAPTURE_FOUNDATION_DESIGN.md): background capture direction, persistent evidence APIs, and [validation](docs/chatbox/CAPTURE_FOUNDATION_VALIDATION.md).
- [Chatbox implementation](docs/chatbox/CHATBOX_IMPLEMENTATION_DESIGN.md): references, annotations, task messages, history and the project-managed browser; [validation](docs/chatbox/CHATBOX_IMPLEMENTATION_VALIDATION.md).
- [Inline references and point markers](docs/chatbox/INLINE_REFERENCES_POINT_ANCHOR_DESIGN.md): caret placement, saved reference positions and anchored annotation numbers; [validation](docs/chatbox/INLINE_REFERENCES_POINT_ANCHOR_VALIDATION.md).
- [Browser-independent capture](docs/chatbox/UNIVERSAL_BACKGROUND_CAPTURE_DESIGN.md): shared display/evidence pixels, persistent HTML surfaces and [implementation results](docs/chatbox/UNIVERSAL_BACKGROUND_CAPTURE_IMPLEMENTATION.md).
- [Loading and playback performance](docs/INTERACTIVE_MEDIA_PERFORMANCE_VALIDATION.md): measured loading, HTML input and active-media interactions, including the remaining native smooth-scroll capture limitation.
- [Inline reference geometry](docs/chatbox/INLINE_REFERENCE_GEOMETRY_VALIDATION.md): matching preview and confirmed dimensions, text line height and native editing.
- [Agent Skill](skill/acanvas/SKILL.md): task processing and recovery.

## Install and run

The project requires Node.js 24. Project scripts automatically select the project-local runtime when installed. The following setup keeps the runtime and package cache inside the project and preserves your global Node configuration:

```sh
npm install --prefix .runtime --no-save --package-lock=false --cache .npm-cache --registry=https://registry.npmjs.org node@24
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm install --prefer-offline --include=dev --foreground-scripts --fetch-timeout=60000 --fetch-retries=2 --cache .npm-cache --registry=https://registry.npmjs.org
npm run build
npm run cli -- project open --project "$PWD" --port 4317
```

`project open` starts or reuses the project's background service and returns its verified URL. The service continues running after the launcher or agent turn ends. `--project` identifies the project that owns the data; connection and shutdown commands verify the project and service instance.

```sh
npm run cli -- project status --project "$PWD"
npm run cli -- project stop --project "$PWD"
```

By default the service binds `127.0.0.1` and accepts only `127.0.0.1`/`localhost` hosts. To reach it through a forward or private network address, opt in when the call starts the service:

```sh
npm run cli -- project open --project "$PWD" --port 4317 --bind 0.0.0.0 --allow-host grok-bot:4317,100.104.202.58:4317
```

`--bind` accepts `127.0.0.1`, `0.0.0.0` or `::`; `--allow-host` takes comma-separated `host[:port]` values (the service port is used when omitted). `ACANVAS_BIND` and `ACANVAS_ALLOWED_HOSTS` provide the same settings. Allowed hosts extend the Host, Origin and same-origin checks; the options are recorded in runtime metadata, `project open` returns the extra addresses in `urls`, and CLI calls continue to use `127.0.0.1`. Stop and reopen the project to change them. An allowed `host:443` entry describes an HTTPS front such as a TLS proxy.

HTML preview frames use a separate server. Remote boards need a fixed `--preview-port` and `--preview-host` origins (`ACANVAS_PREVIEW_PORT`, `ACANVAS_PREVIEW_HOSTS`); a board never receives its own origin, prefers a preview on another hostname, and an HTTPS board only receives HTTPS previews. Use HTTPS preview origins for non-loopback hosts: browsers send the `Sec-Fetch-*` headers that the preview server requires only to secure origins, so a plain-HTTP remote preview is rejected. Example with a Tailscale HTTPS front (`tailscale serve --bg --https=443 http://127.0.0.1:4317` and `--https=8443 http://127.0.0.1:4318`):

```sh
npm run cli -- project open --project "$PWD" --port 4317 --bind 0.0.0.0 \
  --allow-host grok-bot:4317,100.104.202.58:4317,grok-bot.example.ts.net:443 \
  --preview-port 4318 --preview-host https://grok-bot.example.ts.net:8443
```

When the HTTPS board and preview share a hostname and differ by port, browsers treat them as different origins but share cookies. The board cookie stays `HttpOnly`, `SameSite=Strict` and `Path=/api`, the preview server ignores cookies, and preview documents run sandboxed with an opaque origin.

Use an explicit session ID or its URL to keep requests in the intended task scope. An agent can also use its host binding when available. For a foreground service, use `npm start`; Ctrl+C shuts it down normally.

Dynamic HTML uses a project-installed CEF runtime. The current native package supports macOS arm64 and requires CMake and Apple Clang. Install it with:

```sh
npm run install:html-runtime
```

The installer stores the SDK and compiled helper in `.runtime/`. HTML surfaces start in the background on demand, with temporary profiles and a private clipboard. Images, files, Markdown, audio, video, GIF and their captures work independently of HTML engine initialization. Stop a running project before rebuilding its served application, then reopen the same project and session.

`project open --session SESSION_ID` opens that scope directly. Explicit session selection takes priority over automatic environment binding; use `--host` and `--thread` when an association is intended.

Open the returned whiteboard URL in a supported browser or WebView. Done uses the page's own Canvas frame through the project API. The optional managed-browser commands use installed Google Chrome with a separate profile; replace `SESSION_ID` with the scope from the URL, `session list`, or `session create`:

```sh
npm run cli -- session list --project "$PWD"
npm run cli -- browser open --project "$PWD" --session SESSION_ID
npm run cli -- browser status --project "$PWD" --session SESSION_ID
npm run cli -- browser close --project "$PWD" --session SESSION_ID
```

An optional managed page remains open after the launcher exits. `project stop` closes the project's managed browser and service.

For UI development, first stop the project's existing background service with `npm run cli -- project stop --project "$PWD"`. Then run these commands in separate terminals:

```sh
npm start -- --project "$PWD" --port 4317 --dev-origin http://127.0.0.1:5173
npm run dev
```

A production service rejects duplicate instances and unapproved development origins.

## Workflow

1. Open the project whiteboard in the intended session. Materials and layout belong to the project; requests belong to that session.
2. Import, drop, or paste materials onto the canvas. Choose **Add note** on the left toolbar, then click the canvas to place a plain-text note and type immediately. Select a note, then hover the color control to the right of Delete to pick a background. Markdown documents open in preview; the eye and code switch at the block's top right edits the same file. Selecting objects previews each reference at the current or last composer caret; entering the composer confirms them in place. Type `@` to select objects or tasks from the current session. The same source can appear several times, and each occurrence moves with text edits, can be removed individually, and keeps its position after refresh or queue editing. Confirmed references retain the original name and neutral appearance, with stronger text contrast.
3. Use the global **Mark** tool to highlight the material under the pointer, then mark a point or region. Blank canvas and areas crossing materials also accept comments. The highlighted material becomes the comment target. Choose **Mark** again to place the mark somewhere else. A point bubble's lower-left corner sits on the clicked position, with its comment beside it on a translucent background. Enter a comment and choose **Done**; the page copies the displayed frame and saves it in the background. Object captures include the complete visible material and mark, while canvas comments use their selected region. Annotation summaries keep their thumbnails above the composer. Short upload failures recover using the same copied pixels; failures retain the comment, which can be reopened and completed with **Done**.
4. Add instructions and send. Text, formal references and complete annotations become one task. Task history displays the saved scene, and current-object location is a separate action. Dragging, multi-selection, alignment and Alt snapping bypass retain their canvas controls. The composer supports Enter to send and Shift+Enter for a new line.
5. The agent reads the repository Skill and processes requests within the explicit project and task scope. The UI can copy a resume prompt containing the current whiteboard link.
6. The agent registers outputs, publishes canvas changes, completes the task, and proceeds to the next request. Processing stops when the queue is empty or user input is needed.

CLI and Skill entry points:

```sh
npm run cli -- project open --project "$PWD" --port 4317
node skill/acanvas/scripts/acanvas.mjs --help
```

When called directly from Codex, the CLI can use the trusted `CODEX_THREAD_ID` to bind the host conversation. When delegating, pass the parent conversation's host/thread identity or its bound whiteboard link. A browser opened without a bound link receives a tab-local task scope, retained in the URL across refreshes. Existing links and tasks remain available.

Other agents use the same project and session commands. A task exposes the same readable requirement in its JSON context and plain text:

```sh
npm run cli -- task read --project "$PWD" --session SESSION_ID --task TASK_ID --format text
```

Each queue activation uses a new consumer ID, kept stable throughout that processing loop. Completed or transferred execution identities remain in task history. See CLI help and the Skill for claim, resume, and output publication parameters.

## Content types and interactions

Images, video, GIF, Markdown, audio, and HTML share import, selection, layout, annotation, and task references. Original files are retained. Other formats appear as downloadable file cards.

| Format | Canvas interaction |
| --- | --- |
| Images, GIF, video | Images and GIFs render directly; video includes playback controls. Resizing preserves the media aspect ratio. |
| Markdown | Rendered text, lists, code, and links support selection and scrolling. Ordinary wheel gestures scroll the text; Ctrl/Meta-wheel zooms the canvas. Drag blank content areas or the filename to move the block. Four corner handles and four edge midpoints resize width and height independently. |
| Audio | A compact, unified player contains embedded artwork, the track name, playback controls, and a complete amplitude waveform. Click or drag the waveform to seek across the whole track. Audio references can include specific times or intervals. |
| HTML | Current-page controls send pointer and keyboard input to the persistent preview. Ordinary wheel and trackpad scrolling over the preview or its controls pans the canvas; Ctrl/Meta-wheel and trackpad pinch zoom it. Each view supports four active instances, with sixteen active instances per project. Previews waiting for project-wide or retained-surface capacity continue automatically after resources are released; the per-view limit produces a clear capacity error. Drag the filename to move the block, and use eight resize handles to adjust width and height independently. |

Select two or more main-board items and choose Group to frame them. New groups receive the project-wide names Group 1, Group 2, and so on; custom names stay as entered. Drag the group title or its empty frame area to move its members together. Choose Rename to edit the name in place, or Store in folder to collect its contents. The folder stays at the frame's top-left corner and shows the first three items in creation order. Click its name or item count to select the group and preview its members as request references; focus the request to add them. The same name area supports dragging, keyboard selection and touch. Click the cover to edit its board; Back to board restores the main-board camera. Items added inside the folder join that group. Expand on board expands its current contents, and Ungroup keeps every item and material.

Folding first brings right-hand items closer, then items below, with 24px spacing. Other groups move together. Expanding makes space in the same order. Group actions use compact icon buttons with tooltips and accessible action names. A pencil with a baseline renames the group; paired folder arrows collect or expand its contents; the Font Awesome Regular object icons group and ungroup them. Folder hover actions and the folder board keep the same action order on wide and narrow screens. Selection controls place Delete last: Group, Align, Delete for multiple items, or Color, Delete for one note. Folder colors persist across refreshes. The 216×224 folder cover has a lower back, small corners, archive lines extending toward the bottom, and a right-hand column with the group name and item count. Its first three item previews show their content without a surrounding frame. Hover gently opens the cover and previews while its position stays fixed. Creation chooses cobalt, sage, coral, lilac, ink, or sand at random; CLI creation can provide `color` explicitly. Its 216×256 layout includes the editable name below the cover. Groups belong to the project and are shared across task contexts; each context retains its current board view.

The CLI reads groups and their files directly. Both board levels use project world coordinates. `group read` returns the group, its current `displayBounds`, and ordered `members` with each original object and asset, including file names, IDs, versions and item layout:

```sh
npm run cli -- group list --project "$PWD" --session SESSION_ID
npm run cli -- group read --project "$PWD" --session SESSION_ID --group GROUP_ID
npm run cli -- group put --project "$PWD" --session SESSION_ID --group GROUP_ID --object OBJECT_ID --version OBJECT_VERSION --x 100 --y 200
```

`group put` moves an existing item into the group while keeping its identity, original asset and source history. Omit `--x`/`--y` to keep its current world position. Read the group back after placement; use ordinary object updates to change member positions or dimensions. The shared service refreshes both the source and target groups in the same transaction. Read current object/group versions before changes:

```json
{"operations":[{"type":"group.create","group":{"name":"References","objectIds":["A","B"]},"expectedVersions":{"A":1,"B":1}}]}
```

```json
{"operations":[{"type":"group.update","groupId":"GROUP_ID","expectedVersion":1,"changes":{"mode":"folder"}}]}
```

Use `group.update` with `mode: "frame"` to expand, or `group.ungroup` with `groupId` and `expectedVersion` to keep members on the main board. `create.object.groupId` creates an item in an existing group. An object `update` with `changes.groupId: "GROUP_ID"` moves it into that group; `changes.groupId: null` returns it to the main board. These operations also work through `task complete`. State and board-operation responses include `groups`; object identities and original asset IDs continue to support historical references.

A mixed selection can share one group annotation, with a common number and comment while preserving each material's source. Image and video region annotations retain explicit region bounds.

Canvas controls, including audio timelines, inherit canvas pan and zoom gestures. Components that need ordinary content scrolling declare a content wheel region; click, drag, and keyboard controls retain their own behavior. See [canvas input responsibilities](docs/CANVAS_INPUT.md) when adding a component.

HTML previews support self-contained files and explicitly imported local resource bundles in an isolated origin. A persistent project renderer produces the displayed pixels; current-page controls forward input to that instance. Closing the owning page or removing its preview releases the running instances. Brief connection interruptions retain state; a restarted instance starts its script state again. Retained pixels and completed evidence preserve their captured view. Remote resources and host-specific APIs require further integration. Markdown displays raw HTML as text and uses source placeholders for embedded images.

Browser project updates and view presence share an authenticated WebSocket connection, while assets and business operations use the HTTP API. Multiple open pages keep their own task and preview state without reserving persistent HTTP connections for these notifications.

HTML file controls accept up to 32 selected files and 8 MiB total per selection, with up to 32 MiB retained by one runtime. Files travel as selected bytes. Select, date and color controls submit values through the input bridge; their source `input/change` events are synthetic. Composition event properties follow the installed engine. See the implementation results for the measured input and accessibility scope.

To import HTML with separate local CSS, JavaScript and images, select the entry file and its resource directory:

```sh
npm run cli -- asset import --project "$PWD" --file "$PWD/site/index.html" --bundle-root "$PWD/site"
```

Use a dedicated directory containing the files intended for the preview. `--bundle-root` explicitly authorizes that source directory, including when it is outside the project. The service stores the original files and their relative-path mapping inside the target project's `.acanvas/`; moving or deleting the source directory does not affect the saved preview. Imports without `--bundle-root` retain single-file behavior. Importing registers an asset; use the returned entry asset ID in `board operations` or `task complete` to create its canvas item. An open canvas receives the normal change notification and generates a snapshot automatically when the item is visible.

Bundles accept HTML, CSS, JavaScript, images and fonts, up to 128 files and 128 directories (including the entry and root), 10 MiB per file and 32 MiB total. Hidden files/directories are skipped; symlinks and unsupported file types are rejected. Finish generating the directory before importing it; changes during import cause the operation to stop. Use relative resource URLs, including inside CSS; absolute site-root paths such as `/assets/style.css` are not mapped. A captured frame preserves the glyphs and other pixels that the instance displayed.

Audio waveforms are calculated from the complete file on first view; playback uses the native audio element. A small waveform summary is reused on remount and in the same browser tab across refreshes. Waveform decoding currently supports files up to 32 MB. If waveform decoding is unavailable, native playback and time-based seeking remain available when supported by the browser. Audio playback and HTML runtime state are local viewing state; tasks preserve original files and explicitly submitted annotations.

See the [multimodal design](docs/MULTIMODAL_CANVAS_DESIGN.md) for interaction and reference semantics, and the [validation record](docs/VALIDATION.md) for tested formats and browsers.

## Validation

```sh
npm run typecheck
npm run build
npm test
npm run demo
npm run test:browser
```

Additional focused browser suites:

```sh
npm run test:browser -- --config tests/audio-player.config.ts
npm run test:browser -- --config tests/content-surface.config.ts
npm run test:browser -- --config tests/html-preview-security.config.ts
```

The isolated background capture prototype uses the project runtime and a managed Chrome page:

```sh
.runtime/node_modules/node/bin/node scripts/chatbox-capture-prototype.mjs background
```

The prototype preserves the initial capture experiments. Current capture uses the open whiteboard's SceneRenderer and project API; see the browser-independent capture implementation results. The optional visual HTML prototype installs its test engine with `npm run install:render-engine`.

Tests use isolated temporary projects. Localhost services and Chrome may require execution permissions in restricted environments. Validation records distinguish environment restrictions from product failures.

## Data and change history

Git tracks source, plans, tests, dependency locks, and necessary validation artifacts. Runtime data lives in the target project's `.acanvas/` directory, including its database, original materials, and generated outputs. This directory is excluded from Git. Tasks, execution attempts, and receipts retain operation history.

Automated backup and recovery commands are planned. To make a manual archive, stop the service normally and copy the complete `.acanvas/` directory, including the database and all associated materials.

Check Git status before implementation and organize changes by planned stages and requirements. Record verification results and complete the applicable acceptance process before committing. The project plan records implementation status; `git log` and `git show` provide version history.

## Support boundaries

- Finder file paste has been confirmed manually in the Codex in-app browser. Broader operating system, file type, Safari, and host coverage remains under validation. Automated coverage and manual confirmation are recorded separately.
- Video and audio playback depend on browser codec support. Original files remain available. Full video understanding is provided by the chosen agent or parsing tools.
- Image generation and Pinterest imports require further integrations. The service currently provides material and task interfaces; agents use their existing tools for creative work.
- The current design targets one user on one machine. Cloud and cross-device access, comprehensive backup/recovery, and standalone distribution are planned work.
