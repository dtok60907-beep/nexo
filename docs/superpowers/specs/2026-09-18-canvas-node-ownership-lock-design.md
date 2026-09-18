# Canvas Node Ownership Lock Design

## Goal

Prevent one collaborator from changing a Canvas node while another collaborator is actively working on that same node. Collaborators continue to receive realtime updates and may work on other nodes. Video generation is portrait-only at `9:16`.

## Scope

The rule applies to Prompt, Image, Video, and Reference nodes. A lock covers every user mutation of its node: text edits, mention selection, drag, resize, delete, toolbar actions, model/settings changes, generation actions, and edge/handle connections.

It does not lock the full Canvas. Other nodes remain editable by other collaborators.

## Server-authoritative node lease

Replace the Prompt-only lease table/API with a generic `canvas_node_locks` lease keyed by `(project_id, node_id)`. A lock owner is `(user_id, participant_id)` and has a 15-second expiry. The active client renews it every 5 seconds.

`claim` succeeds when the lock is expired or belongs to the same user/participant. `heartbeat` succeeds only for the current live owner. `release` deletes only the current owner's row. All lock API requests verify project ownership.

A failed claim returns conflict status and owner-safe UI messaging. The server does not expose private user data. Expiry recovers locks after a browser crash, tab close, or network loss.

## Client interaction model

Canvas claims a node lock synchronously at the start of an interactive gesture. Until successful, it does not write node state. For lock owner, interactions continue normally and a heartbeat runs for as long as the interaction/editor remains active.

The owner also publishes `{ activeNodeId, mode }` through existing Yjs awareness/presence. Other clients receive the state immediately and render that node as view-only before a gesture can begin. Awareness is only UI state: disconnect/reconnect can discard it, while the server lease remains the authority used to accept or deny claims.

For every non-owner, a locked node is view-only:

- no drag or resize;
- no text editor, mention picker, toolbar operation, deletion, generation setting, or submit;
- no source/target handle connection;
- realtime CRDT updates continue rendering.

The UI overlays locked nodes with a small non-interactive message, e.g. “Being edited by another collaborator.” It does not reload Canvas or replace CRDT data. Lock is released on editor blur, completed drag/resize, closing a toolbar/popover, unmount, and explicit cancellation. A 15-second lease expiry is the fallback only.

## Realtime safety

Yjs granular field updates remain in place. The lease prevents competing UI actions; it does not replace CRDT conflict resolution. The Canvas must treat network/API lock errors as local recoverable UI errors rather than route-level failures, avoiding the “This page couldn't load” reload screen.

## Portrait-only video

Video node state initializes and normalizes `aspectRatio` to `9:16`. The aspect-ratio selector is removed from the Video node. Model changes cannot replace it. The generation submit route sets video `aspectRatio` to `9:16` and rejects a non-`9:16` client value. The BytePlus adapter emits provider-native `ratio: '9:16'` for the Seedance request.

Image-node aspect-ratio choices are unchanged.

## Tests

- Lock service: claim, owner heartbeat/release, non-owner conflict, expiry takeover.
- Canvas interaction guards: locked non-owner cannot initiate each node mutation; owner and unrelated nodes can.
- Prompt typing remains realtime-visible but non-owner editing is blocked.
- Video UI state/payload always resolve to `9:16`; API rejects other video ratios.
- A failed lock API request leaves Canvas mounted and shows a recoverable message.

## Non-goals

- No project-wide exclusive editing.
- No lock history/audit UI.
- No automatic retry of historical generations.
