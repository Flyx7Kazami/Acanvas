# acanvas

A local, project-based creative whiteboard for collaborating with agents through a shared Agent Skill.

Import images, video, audio, and documents, select materials, and add annotations. Send references and instructions to a request queue bound to your current host conversation. Agents process requests through the CLI, use their existing creative tools, and publish results back to the shared canvas.

## Status

The runnable P0 prototype includes a full-screen canvas, floating controls, an adaptive composer, an expandable request queue, material imports and annotations, host conversation binding, and a persistent local service. The latest multimodal interactions support direct document interaction, eight-point resizing, embedded audio artwork, and a compact player with a complete audio waveform.

- [Project plan](docs/PLAN.md): requirements, architecture, implementation stages, and acceptance criteria.
- [Frontend design](docs/FRONTEND.md): visual references, grayscale themes, and interaction rules.
- [Multimodal canvas design](docs/MULTIMODAL_CANVAS_DESIGN.md): content types, references, and preview boundaries.
- [Validation record](docs/VALIDATION.md): verified behavior and remaining limitations.
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

Use the bound URL returned by `project open` to keep requests associated with the current host conversation. For a foreground service, use `npm start`; Ctrl+C shuts it down normally.

For UI development, first stop the project's existing background service with `npm run cli -- project stop --project "$PWD"`. Then run these commands in separate terminals:

```sh
npm start -- --project "$PWD" --port 4317 --dev-origin http://127.0.0.1:5173
npm run dev
```

A production service rejects duplicate instances and unapproved development origins.

## Workflow

1. Open the project whiteboard using the bound link from your agent. Materials and layout belong to the project; requests belong to the current host conversation.
2. Import, drop, or paste materials onto the canvas. Select materials and choose **Annotate** to add a comment, or attach them to a request. Dragging snaps to other materials. Use Shift for multiple selection, **Align** for alignment, and Alt to temporarily bypass snapping. The composer grows with its content; Enter sends and Shift+Enter adds a line.
3. Add instructions and send. Requests are saved in the queue with their status and completion receipts.
4. The agent reads the repository Skill and processes requests within the explicit project and task scope. The UI can copy a resume prompt containing the current whiteboard link.
5. The agent registers outputs, publishes canvas changes, completes the task, and proceeds to the next request. Processing stops when the queue is empty or user input is needed.

CLI and Skill entry points:

```sh
npm run cli -- project open --project "$PWD" --port 4317
node skill/acanvas/scripts/acanvas.mjs --help
```

When called directly from Codex, the CLI can use the trusted `CODEX_THREAD_ID` to bind the host conversation. When delegating, pass the parent conversation's host/thread identity or its bound whiteboard link. A browser opened without a bound link receives a tab-local task scope, retained in the URL across refreshes. Existing links and tasks remain available.

Each queue activation uses a new consumer ID, kept stable throughout that processing loop. Completed or transferred execution identities remain in task history. See CLI help and the Skill for claim, resume, and output publication parameters.

## Content types and interactions

Images, video, GIF, Markdown, audio, and HTML share import, selection, layout, annotation, and task references. Original files are retained. Other formats appear as downloadable file cards.

| Format | Canvas interaction |
| --- | --- |
| Images, GIF, video | Images and GIFs render directly; video includes playback controls. Resizing preserves the media aspect ratio. |
| Markdown | Rendered text, lists, code, and links support selection and scrolling. Drag blank content areas or the filename to move the block. Four corner handles and four edge midpoints resize width and height independently. |
| Audio | A compact, unified player contains embedded artwork, the track name, playback controls, and a complete amplitude waveform. Click or drag the waveform to seek across the whole track. Audio references can include specific times or intervals. |
| HTML | Visible blocks automatically render a static snapshot. Choose **Interact** to use its controls, or **Refresh snapshot** to update the image; up to four HTML instances can run per page, including snapshot generation. Inactive blocks retain an image of their content. Reload and stop controls remain outside the live preview. Drag the filename to move the block, and use eight resize handles to adjust width and height independently. |

A mixed selection can share one group annotation, with a common number and comment while preserving each material's source. Image and video region annotations retain explicit region bounds.

HTML previews support self-contained inline styles, scripts, and data images in an isolated origin. Snapshot generation shares the same four-instance limit as live interaction and waits for an available slot. Offscreen and stopped previews release their running slots; a retained snapshot can be displayed without rerunning the file. Snapshots preserve an image, not restorable script or form state. Live preview grants expire after ten minutes and can be restarted. External resources, host-specific APIs, and resource bundles require further integration. Markdown displays raw HTML as text and uses source placeholders for embedded images.

Audio waveforms are calculated from the complete file before playback; playback uses the native audio element. Waveform decoding currently supports files up to 32 MB. If waveform decoding is unavailable, native playback and time-based seeking remain available when supported by the browser. Audio playback and HTML runtime state are local viewing state; tasks preserve original files and explicitly submitted annotations.

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
