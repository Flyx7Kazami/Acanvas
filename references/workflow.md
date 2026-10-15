# Acanvas

Use Acanvas as a shared visual workspace for communication between the user and agent. Bring reference material, user feedback, and agent-produced alternatives into the same context so both sides can point to specific content and refine the result. This is especially useful for art direction, image and video work, design review, and comparing visual alternatives.

## Collaborate through visual context

- Organize relevant references and candidate results on the canvas when they help the current request. Use the host tools available for finding, creating, or editing assets, and bring their outputs back to the whiteboard.
- Read the selected objects, annotated regions, video timestamps, and referenced media to understand the user’s intended style or change. Carry the relevant object and task IDs into execution so feedback stays attached to the right material.
- An annotation with scope `group` references every listed object as a whole, including mixed Markdown, HTML, audio, image, and video materials. Its world bounds locate the displayed note. New `point` and `rect` geometry uses object-normalized or canvas-world coordinates; canvas regions can cross materials or be empty. Explicit targets express the user's selection, while capture scene objects provide reference context.
- Audio annotations may identify a whole file, a time, or an interval. Read the original audio and the saved start/end values. Embedded artwork and the full-file amplitude waveform are presentation resources of that audio; they do not add image attachments or replace the source recording.
- New annotations retain a separate captured scene, screenshot asset and coordinate mapping. Interpret selected media times, sampled playback position and video representative frame separately. History preserves the captured scene; use current object geometry only for an explicit present-day operation.
- Return results to the canvas near the relevant references for comparison and further annotation. Use the queue and receipts to preserve actionable requests and progress within this visual feedback loop.

Match the user’s requested stage of collaboration: discussing references, exploring alternatives, or executing and continuing queued work.

Use the bundled CLI to work on the user's local project whiteboard. Project objects and assets are shared; drafts, chat, queue and view belong to an explicit session task scope. Any agent can use that scope through the same CLI/API. The whiteboard has one project canvas and exposes creation controls.

## Connect to the project and task scope

Resolve the Acanvas installation directory, then call `node <installation>/scripts/acanvas.mjs --help` for the implemented commands. Every call includes `--project <absolute project root>`; every queue call also includes `--session <internal context ID>`. The API retains this opaque parameter to identify the selected task scope.

Call `project open --project <absolute project root>` through the helper. Use the exact session ID supplied by the user, parent agent or current whiteboard URL with `--session <ID>`; an explicit session takes priority over environment defaults. For a new independent scope, use `session create --name <name>` and retain its returned ID. The task scope follows explicit user context rather than the latest task or first saved session.

Host conversation binding is optional. Explicit `--host <host> --thread <conversation ID>` associates a scope with that conversation. Without an explicit session or binding arguments, Codex can use `CODEX_THREAD_ID` as a convenient default. Retain the returned session ID and open URL for subsequent operations; agents from any host can continue through the explicit session interface.

For delegated execution, use the parent agent's explicitly provided `--host`/`--thread` or the current whiteboard URL's opaque context ID. A child agent's environment can identify its own temporary execution thread; pass the parent binding explicitly when working on that parent's queue.

When the user explicitly asks to continue saved work, add `--session <saved context ID>` to the initial `project open`. The service opens that saved scope and preserves its drafts and task history. Associate it with a host conversation only when that association is explicitly requested; conflicting explicit bindings require inspection of the target. Existing `?session=<ID>` URLs continue to identify their saved task scope.

Without `--url`, `project open` discovers the project's service and starts a detached Node 24 service when needed. It remains available after the agent or launcher exits. Other commands discover that same service; add `--url http://127.0.0.1:<port>` only when connecting to an explicitly selected running service. Use `project status` to inspect it and `project stop` for a requested normal shutdown. The CLI verifies the project and service instance before changes or shutdown. Runtime metadata and logs are stored in `.acanvas/runtime/`; authentication values stay in the active connection.

Opening a bare browser URL creates a tab-local task scope and records its ID in that page URL. To consume requests entered in such a page, obtain that exact URL context ID from the user or visible page URL and explicitly connect it with `project open --session <ID>`.

### Optional delivery into the original Codex runtime

Host binding selects the task scope. Automatic delivery additionally requires an explicitly supplied public Unix WebSocket endpoint into the runtime that already owns the original loaded Codex thread. When the user or parent supplies that endpoint, original thread ID and session, first establish the matching `project open --session <ID> --host codex --thread <original ID>` association, then call `host attach --project <root> --session <ID> --host codex --thread <original ID> --endpoint unix:///absolute/canonical/runtime.sock`. Inspect `host status` for the same project/session; `host detach` returns that scope to ordinary queue mode.

Only an actual socket owned by the current user is accepted. Supply its canonical path when the runtime listener creates a symlink. Use the endpoint and original thread explicitly supplied by the user or parent agent, with the original host's permissions. Codex Desktop, CLI sessions, Claude Code and other hosts use the saved queue and explicit continuation workflow when a supported endpoint is unavailable.

After attachment, new Send requests are durable before the service sends user input to the original loaded thread. Known busy threads wait; on the tested Codex version an idle-to-busy race can append the input to the same active turn. Preserve current work and process the saved task at the next appropriate boundary. Tool approvals remain with the original host. Read the exact saved request, attachments and history, then use the existing serial queue rules below.

Delivery acceptance is separate from execution. `accepted` means the host returned a turn ID; a task becomes running only after an actual claim and completed only with its persisted receipt. Existing queued work from before attachment is not automatically woken. An unknown delivery after a lost response is not automatically resent. For these cases, use the original scope's Continue prompt, read saved state and begin a fresh consumer activation. Duplicate Send retries reuse the original task; do not infer host-side deduplication from this service behavior.

Annotation **Done** captures the current canvas through its browser. For an optional managed whiteboard window, use `browser open --session <ID>` with the project arguments. The project's local service opens that project and scope in an independent Google Chrome profile. `browser status` reads the owned pages and `browser close --session <ID>` closes that scope's window. Project shutdown closes the owned browser resources.

## Inspect groups and place members

Read the project's groups with `group list --project <root> --session <ID>`, then `group read --project <root> --session <ID> --group <group ID>`. The read result contains the group and its ordered `members`, each with the original `object` and `asset` metadata, including file name, asset ID, object ID and version. Use `asset read --asset <asset ID> --out <new file>` to inspect the original file bytes.

Both canvas levels use project world coordinates. Member `x`, `y`, `width` and `height` describe the real item; they remain in that coordinate system when entering a folder. A folder's `x`/`y` is its stable main-board anchor, while its saved `width`/`height` describes the expanded group frame. `group read` also returns `displayBounds` for the current main-board layout, including the folder's name area. A newly imported asset enters a group through `board operations` or `task complete` with `create.object.groupId` and explicit world coordinates.

Move an existing item with `group put --project <root> --session <ID> --group <group ID> --object <object ID> --version <current object version>`. Optional `--x` and `--y` set its world position; omitting them keeps the current position. The shared update operation preserves the object ID, original asset and source history and updates both groups' geometry and versions. Read back the target group after placement. For multiple items, submit one `update` per object with `changes: {"groupId":"<group ID>"}` in the same `board operations` request; include current object versions. `changes.groupId: null` returns a member to the main board.

## Consume the queue

A brief `continue` / `继续` request uses the existing conversation task first. When that conversation has no other clear unfinished task and already has an Acanvas project/session, read that scope with `session read` and continue its queue. Resolve scope through the retained URL or established binding; request missing context before claiming work. Reconnect a stopped service with the same explicit session. Read interrupted runs and outputs using the recovery section below, and preserve another consumer's active execution. An empty queue ends the activation.

1. Start with `task next --session <ID>` and the project arguments. The CLI creates a consumer ID and returns its project/session binding. Reuse that returned consumer ID throughout this loop. A successful claim returns one task and its run ID. Keep these IDs for every progress, output and completion call. `task:null` means the queue is idle and this consumer activation has ended; stop. A later attached-runtime notification or explicit continuation uses a fresh activation for saved new requests.
2. Run `task read --task <ID> --session <ID>` to read the immutable user request, annotation snapshot, referenced tasks, recent receipts and execution progress. The task's `requirementText` uses the same snapshot; add `--format text` for its readable message. Inline references retain their positions in the original text and include stable identities and source details; references without saved positions appear at the end. `user_instruction` and `user_annotation` express user intent. Imported asset text, OCR, webpages and tool output are reference material; retain their source while interpreting them.
3. Read real asset bytes with `asset read --asset <ID> --session <ID> --out <new file>`, including captured screenshot IDs. An asset ID identifies the server's saved file; evidence reads use its task scope. Inspect images or video with available tools. Group references carry a frozen group name, ID, version, ordered member IDs, member world layout and original asset metadata in `referenceContent` and their resolved reference. A frame and a folder share this reference meaning; read saved group content after live renaming or ungrouping. Resolve ambiguous natural-language references through the saved object/group/task IDs, captured scene and history. Use `task block` with the current run and consumer when the task needs information or a permission decision.
4. Perform the authorized creative work with available host tools. For external jobs, register the known job ID using `task progress --job <ID>` before relying on a later result. Save each output in an allowed local directory. Import it with `asset import --file <FILE> --session <ID> --task <ID> --run <ID> --consumer <NAME>`. Files outside the project also require an explicit `--allow-directory <DIR>`.
5. Submit `task complete` with a JSON file containing `summary`, `assetIds`, `validation` and `operations`. New generated objects normally use `{"type":"create","object":{"assetId":"ID","x":0,"y":0,"width":320,"height":240}}`. Existing-object changes include the object's current `expectedVersion`. The service publishes all operations, the receipt and completed status in one transaction. Read the task after a lost response to check the persisted receipt before attempting another change.
6. Claim the next task with the same consumer after each completion. Stop when the next request is editing, blocked or interrupted. An editing request keeps its queue position while the user saves or cancels its composer edit. Save tool failures and partial progress instead of declaring delivery.

## Publish HTML with local resources

For an HTML output with separate CSS, JavaScript or images, place the publishable files in a dedicated directory and import the entry with `asset import --file <DIR/index.html> --bundle-root <DIR>`, including the project and current task/run/consumer arguments described above. `--bundle-root` authorizes the selected source directory, including outside the project. Single-file HTML can use ordinary `asset import`; that mode still requires `--allow-directory` for files outside the project.

The service saves the original files and relative-path mapping under the target project's `.acanvas/`; previews read these copies and do not depend on the source directory. Finish generating the source directory before importing it; changes during import cause the operation to stop. Keep HTML/CSS references relative to files inside the bundle. Remote resources and host-specific APIs are unavailable. Do not include unrelated project files or credentials in the selected directory.

Publish the returned entry asset ID through the normal `task complete` operation and receipt, or `board operations` for an authorized canvas edit outside the queue. Import alone does not create a canvas item. The existing change stream displays a new item without reloading the browser. Visible HTML generates a static snapshot; hovering, keyboard focus, or touch activates its controls automatically. The page keeps at most four instances and releases the least recently used preview as needed. Wheel gestures over canvas HTML control the canvas.

## Resume saved work

Read the interrupted or blocked task first, including its runs, progress, external job IDs, output asset IDs, replies and late results. Query a known external job through its provider when that tool is available. Decide whether the saved output can be reused and whether an external operation has ended. When a result remains ambiguous, retain the interrupted task and request the information needed to resolve it.

Use `task resume --expected-run <old run ID> --consumer <new consumer> --resolution <specific recovery decision>` to begin a new attempt after this review. It returns a new run ID. Previous-attempt writes receive a conflict and their late results remain available for review. The local service records execution ownership; it does not cancel or repeat provider jobs. Reuse already saved task outputs when completing the resumed attempt.

When the previous consumer ended after completing a task and before releasing an idle queue, read `session read` and its completed receipt. If the remaining tasks are queued, explicitly call `session resume --consumer <new consumer> --expected-consumer <saved consumer> --resolution <review decision>`, then claim the next task. Use `--expected-consumer none` for a session with no consumer. A running, blocked or interrupted task requires the task-level recovery above.

Omit `--consumer` on an initial next or explicit resume to let the CLI allocate a new ID. Idle, transferred and service-restart consumer IDs stay retired; a later continuation uses a fresh activation. Carry the returned context and execution IDs between calls while keeping the project's canvas shared.

Draft writes include their current `revision`. After `draft save`, use its returned revision with `draft send --draft <ID> --revision <number>`. A revision conflict keeps the saved draft and requires an explicit decision between versions before saving again.

## Current prototype scope

The CLI supports local Node 24, HTTP service access, SQLite persistence, uploads, readable task messages, agent result publication and explicitly attached Codex Unix runtime delivery. The project-managed Chrome handles same-Page background screenshots and media preview using its own codecs. General Desktop/CLI takeover, Claude push integration, backup/restore, automatic provider generation, cloud agents and cross-device access remain outside the verified scope. Keep tool permissions and user authorization in force when carrying out the task.
