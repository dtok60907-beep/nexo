# Canvas Quality and Collaboration Design

**Date:** 2026-09-22  
**Status:** Approved for implementation planning  
**Area:** `nexoclip-app/services/spite`

## Context

The canvas currently has several usability gaps:

- Prompt content can overflow its fixed-height node after a large paste.
- Scene names cannot be changed from the timeline.
- The add-node menu conflates generator prompts with ordinary canvas text.
- Image and Video Generator nodes repeat the full connected prompt.
- Canvas icons are small and low-contrast.
- Multi-selection has no durable group or user-controlled object lock.
- Video regeneration replaces the visible result without a node-local result history.
- Collaborators can see cursors but cannot exchange short, cursor-attached messages.

This design addresses those gaps without replacing the existing React Flow, Yjs, Hocuspocus, or PostgreSQL projection architecture.

## Goals

1. Keep Prompt content inside its node after typing, paste, reload, and remote updates.
2. Support durable inline scene renaming.
3. Separate generator Prompt nodes from free-form Text and Sticky Note utilities.
4. Remove full prompt previews from generator nodes.
5. Improve canvas icon legibility without changing the rest of the application.
6. Add logical Group/Ungroup and persistent Lock/Unlock behavior.
7. Keep up to 12 selectable results on each Video Generator node.
8. Add temporary Figma-style cursor chat using the existing realtime presence channel.
9. Preserve existing projects and avoid new dependencies or database migrations.

## Non-goals

- Asset deletion, editing, or renaming.
- A Table utility.
- A visual group container or nested React Flow parent nodes.
- Persistent chat, chat history, mentions, rich text, markdown, or links.
- Formula, spreadsheet, or structured-data behavior in utility nodes.
- Global design-token changes outside the canvas.
- Replacing the existing transient collaborator ownership leases.

## Chosen approach

Use the existing data boundaries:

- Persistent node features use optional fields in React Flow node `data`, synchronized through the existing Yjs binding.
- Scene rename uses the existing Yjs scene metadata.
- Cursor chat uses Hocuspocus awareness only and never enters the Yjs document, projector, API, or database.
- Logical grouping stores membership rather than creating React Flow parent nodes.

This is the smallest approach that works with the current collaboration and projection system. Native React Flow parent groups were rejected because they require coordinate conversion, parent-first ordering, copy/paste remapping, projection changes, and broader alignment changes.

## Delivery slices

The approved scope spans independent canvas subsystems. Implementation must be split into separately reviewed and verified slices rather than one large diff:

1. **Canvas correctness:** Prompt auto-sizing, scene rename, Prompt menu label, and hidden generator prompt details.
2. **Utilities and visual clarity:** Utility Text, Sticky Note, and scoped icon adjustments.
3. **Object operations:** logical Group/Ungroup and persistent Lock/Unlock.
4. **Video history:** bounded node-local output history and active-result selection.
5. **Ephemeral collaboration:** cursor chat awareness payload, server validation, and cursor overlay.

Each slice receives its own failing tests, focused implementation, diff review, and verification before the next slice begins. The implementation plan may place slices in separate commits or worktrees, but their data-field contracts must remain consistent with this design.

## Feature design

### 1. Prompt auto-sizing

The Prompt node keeps its current manual width and minimum-height persistence. Its rendered height becomes:

```text
max(saved minimum height or 192px, measured content height), capped at 900px
```

Behavior:

- Local typing, paste, initial load, and remote text updates trigger content measurement.
- The Prompt frame grows and shrinks with content but never below its saved/manual minimum.
- Content beyond 900px scrolls inside the editor instead of overflowing outside the card.
- Manual horizontal and vertical resize remain available; a vertical resize changes the minimum height, not a hard content height.
- A `ResizeObserver` notifies React Flow when the rendered size changes so handles and connected edges are remeasured.
- Computed content height is not persisted on every keystroke. Text and the user-selected minimum height remain the durable inputs, avoiding extra Yjs writes.

This behavior is scoped to Prompt nodes so Comment, Compress, Reference, and Sticker sizing does not change.

### 2. Scene rename

Add a `renameScene(sceneId, name)` collaboration command that updates the matching scene in the existing metadata array.

Timeline behavior:

- Clicking the scene name enters inline editing.
- `Enter` trims and saves.
- `Escape` restores the previous value.
- Blur saves a valid changed value.
- Empty names are rejected and restore the previous value.
- Names are plain text and limited to 80 characters.
- Read-only mode does not expose an editable field.

No schema or projector change is required because scene names already exist in the durable scene projection.

### 3. Prompt and Utilities menu

The add-node menu changes as follows:

- Rename the existing Basics item from **Text** to **Prompt** while retaining its `prompt` node type and `T` shortcut.
- Add a **UTILITIES** category.
- Add **Text** as a new `utilityText` node type.
- Add **Sticky Note** as a new `stickyNote` node type.
- Do not add Table.

#### Utility Text

- Plain editable text for labels or annotations.
- No generator input/output handles.
- Movable, selectable, groupable, lockable, and resizable.
- Persists plain text and dimensions through existing node data.
- Uses transparent/minimal chrome so it reads as canvas text rather than a prompt card.

#### Sticky Note

- Plain editable note with a single default high-contrast note color.
- Movable, selectable, groupable, lockable, and resizable.
- Persists plain text and dimensions through existing node data.
- Uses the new `stickyNote` type rather than the removed legacy `note` type, preserving legacy-note cleanup behavior.
- No color picker, rich text, checklist, or formatting toolbar in this version.

### 4. Hide generator prompt details

Image and Video Generator nodes continue resolving the connected Prompt for validation and generation, but no longer render its full text inside the node.

- Keep disconnected/empty prompt validation on the generate action.
- Keep model controls, voice ID controls, errors, and status feedback.
- Remove only the visible full-prompt block.
- Do not add collapse state or a replacement preview.

### 5. Canvas icon legibility

Apply a scoped canvas pass:

- Left and top toolbar glyphs increase from approximately 13–14px to 15–16px.
- Add-node and node-action glyphs increase by approximately 2px.
- Primary inactive controls stop applying unnecessary extra opacity.
- Use regular or bold icon weight where thin strokes are difficult to see.
- Keep existing button dimensions initially to avoid toolbar reflow.
- Do not change global muted-foreground tokens.
- Do not enlarge React Flow handle containers; changing glyphs must not move edge anchors.

### 6. Logical Group/Ungroup

Persistent membership is represented by:

```ts
data.groupId?: string
```

Behavior:

- Group is enabled for two or more selected nodes in the active scene.
- Group assigns one generated ID to every selected member in one collaboration transaction.
- Selecting one member expands local selection to every member of that group in the active scene.
- React Flow then uses its existing multi-selection movement behavior.
- Delete, duplicate, copy, arrange, and lock actions operate on the expanded selection.
- Ungroup clears `groupId` from every member without changing positions.
- Duplicating or pasting a complete group assigns a new group ID so the copy is independent.
- Internal edges are remapped when the existing duplication path supports them.
- Partial group copy is normalized to the entire selected group rather than creating copied nodes that still reference the original group ID.
- Groups have no separate node, frame, title, nesting, or database record.

If any member is locked, movement, resize, edit, connection, arrange, or deletion of that group is blocked until the locked member is unlocked. This avoids splitting a group through a partial action.

### 7. Persistent Lock/Unlock

Persistent user locking is represented by:

```ts
data.objectLocked?: boolean
```

It is separate from transient collaborator ownership/editing leases.

Locked nodes:

- remain selectable so the user can unlock them;
- cannot be dragged, resized, edited, connected, arranged, deleted, or moved through keyboard or toolbar paths;
- retain normal copy behavior so users can copy content without mutating the locked object;
- expose Unlock through the selection action toolbar.

All mutation paths must consult one shared lock helper rather than adding independent checks to each keyboard and toolbar handler. The UI flags (`draggable`, `connectable`, and `deletable`) provide feedback, while command-layer checks remain authoritative for application behavior.

### 8. Video Generator result history

Each Video Generator node stores at most 12 lightweight entries:

```ts
type VideoHistoryEntry = {
  id: string
  outputUrl: string
  generationId?: string
  createdAt: number
}
```

Behavior:

- A successful video generation appends one unique entry and makes it active.
- Duplicate URLs are not added twice.
- Oldest entries are removed after the 12-entry limit.
- Existing nodes with an `outputUrl` and no history show that current output as the initial item.
- The history strip appears below the video result.
- Each item renders from its durable URL; video binary data and base64 thumbnails are not copied into the history array.
- Selecting an entry updates the node's active `outputUrl`, clears stale active-thumbnail metadata, and lets the existing thumbnail logic recapture if necessary.
- The active choice is durable and shared with collaborators.
- Malformed entries are filtered during normalization rather than crashing node rendering.

This history belongs to one Video Generator node. It is not a replacement for the workspace Asset Library or Jobs panel.

### 9. Ephemeral cursor chat

Cursor chat extends the existing awareness payload:

```ts
type CursorChat = {
  id: string
  revision: number
  phase: 'typing' | 'sent'
  text: string
  expiresAt?: number
}
```

Local interaction:

- Pressing `/` while the pointer is inside the canvas opens a single-line composer next to the local cursor.
- The shortcut is ignored while an input, textarea, select, or contenteditable element owns focus, and while modifier keys or key repeat are active.
- Non-empty drafts are published as `typing` and follow cursor movement.
- `Enter` publishes `sent`; the message remains visible for approximately three seconds.
- `Escape`, empty submission, blur, pointer leave, disconnect, or unmount clears the field.
- IME composition prevents Enter from submitting prematurely.
- Text is plain text and limited to 160 Unicode code points.
- Read-only canvas participants may use cursor chat because it does not mutate the document.

Remote behavior:

- Chat renders next to the existing remote cursor/name using the participant color.
- Only peers in the active scene are rendered.
- Bubbles flip or clamp near viewport edges.
- Typing expires after 30 seconds of inactivity; sent messages expire after three seconds.
- The existing one-second presence projection tick removes expired messages without a new timer or protocol.

Server behavior:

- Validate phase, ID, revision, and text size.
- Normalize whitespace and discard malformed or empty payloads.
- Ignore client-supplied expiry and stamp expiry from server time.
- Preserve expiry for an unchanged `(id, revision)` so normal cursor packets cannot keep a sent message alive indefinitely.
- Do not add a route, table, Y.Map, queue, or separate WebSocket channel.

## Collaboration and compatibility

- All new durable node fields are optional, so existing documents retain current behavior.
- Utility node types are added to the existing registry and generic Yjs node data handling.
- Group and lock changes are written through existing collaboration commands and durable acknowledgements.
- Cursor chat remains awareness-only and is not written by the Yjs repository or projector.
- Scene metadata remains one array value. Concurrent scene rename versus scene create/delete retains the current last-writer-wins limitation; changing the scene CRDT shape is outside this scope.
- No database migration or provider change is required.

## Error handling and security

- Scene names and utility text render as React text, never injected HTML.
- Cursor chat is validated on both projection and server boundaries.
- Oversized or malformed cursor payloads are truncated or dropped without removing the participant's valid cursor presence.
- Stale cursor-chat timeouts are guarded by message ID/revision so they cannot clear a newer message.
- History normalization accepts only bounded entries with usable same-origin or durable media URLs already accepted by the node.
- Lock enforcement is centralized to prevent keyboard, toolbar, resize, and React Flow defaults from bypassing it.
- Backspace/Delete defaults are configured so React Flow cannot delete a locked node outside application handlers.

## Testing strategy

Implementation follows red-green-refactor with focused tests first.

### Unit tests

- Prompt sizing calculation and minimum/maximum behavior.
- Scene rename trimming, rejection, and command projection.
- Group selection expansion, grouping, ungrouping, duplicate ID remapping, and partial-copy normalization.
- Lock checks across move, edit, connect, resize, arrange, and delete helpers.
- Video history append, deduplication, selection, legacy initialization, malformed filtering, and 12-entry cap.
- Cursor-chat validation, Unicode length limit, TTL, stale-timeout protection, and local keyboard state transitions.

### Realtime tests

- Scene names, group membership, lock state, utility text, dimensions, history, and active video output survive Yjs serialization and projection.
- Two clients converge after group, lock, scene rename, utility edit, and video-history selection operations.
- Cursor-chat draft and sent transitions reach another awareness client.
- Cursor chat produces no repository append or projection write and does not recover after reconnect/restart.
- Read-only clients can publish cursor chat while document mutation remains blocked.

### UI/manual verification

Use two browser tabs in one project to verify:

1. Paste a long Prompt locally and remotely; confirm no overflow and correct edge/handle placement.
2. Rename a scene and reload both tabs.
3. Create, edit, resize, reload, and remotely update Utility Text and Sticky Note nodes.
4. Group, move, duplicate, lock, attempt all blocked actions, unlock, and ungroup.
5. Generate or seed multiple video outputs, switch history, and reload.
6. Press `/`, type while moving the cursor, submit/cancel, switch scenes, and confirm expiry.
7. Review canvas toolbars and handles at common viewport sizes.

### Verification commands

Run from `nexoclip-app/services/spite`:

```bash
rtk npm test
rtk npm run test:realtime
rtk npm run lint
rtk npm run build
```

Then review `rtk git diff` and confirm no secrets or unrelated user changes are included.

## Expected implementation areas

Likely files include:

- `components/canvas/add-node-menu.tsx`
- `components/canvas/canvas-workspace.tsx`
- `components/canvas/canvas-collaboration.tsx`
- `components/canvas/scene-timeline.tsx`
- `components/canvas/realtime-presence.tsx`
- `components/canvas/nodes/prompt-node.tsx`
- `components/canvas/nodes/resizable-node-frame.tsx`
- `components/canvas/nodes/image-node.tsx`
- `components/canvas/nodes/video-node.tsx`
- `components/canvas/nodes/node-toolbar.tsx`
- new Utility Text and Sticky Note node components
- `lib/realtime/react-flow-binding.ts`
- `lib/realtime/presence.ts`
- `realtime/server.ts`
- focused existing or new `*.test.ts` files

The implementation plan must narrow this list and keep each task independently testable.

## Acceptance criteria

- Long pasted Prompt text remains contained and usable without leaving the node frame.
- Scene rename is durable and visible to collaborators.
- Basics shows Prompt; Utilities shows Text and Sticky Note; no Table is present.
- Utility Text and Sticky Note persist, resize, and synchronize.
- Image and Video Generator nodes do not display connected prompt text.
- Canvas icons are visibly larger and higher-contrast without moving edge handles.
- Group/Ungroup and Lock/Unlock behave consistently across mouse, keyboard, toolbar, copy, duplicate, arrange, resize, connection, and deletion paths.
- Each Video Generator retains and switches among its 12 latest unique outputs.
- `/` cursor chat follows the cursor, reaches same-scene collaborators, expires, and is never persisted.
- Existing projects load without migration.
- Relevant unit, realtime, lint, and build checks pass.
