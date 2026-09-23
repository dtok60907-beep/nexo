# Independent Collaborative Scene Selection Design

## Goal

Keep each collaborator on the scene they selected instead of moving every connected client when one collaborator changes scenes.

## Root cause

The realtime React Flow binding currently stores `activeSceneId` in the shared Yjs `meta` map. `switchScene` writes that shared field, every client observes the update, and every client derives its visible nodes and edges from the same value. A local navigation action is therefore treated as durable collaborative document state.

## Desired behavior

- Scene definitions, scene names, nodes, and edges remain shared durable state.
- The scene currently displayed is local to each realtime client.
- Opening or refreshing a project selects the first available scene.
- Switching scenes does not emit a Yjs document update or change persistence status.
- Creating a scene synchronizes the new scene to everyone, but only its creator navigates to it.
- Collaborators remain on their current scene while it still exists.
- A client viewing a scene deleted locally or remotely falls back to the first available scene.
- Following a guest explicitly switches only the follower's local scene.
- Read-only participants may switch scenes because navigation no longer mutates the shared document.

## Architecture

The realtime React Flow binding will own a client-local `activeSceneId` alongside its derived snapshot. Shared Yjs projection data remains authoritative for the scene list and canvas content, but the binding uses its local scene ID to filter visible nodes and edges.

`switchScene` will validate the requested ID against the current shared scene list, update the local scene ID, rebuild the local snapshot, and notify local subscribers. It will not start a Yjs transaction.

Document updates will preserve the local scene when that scene still exists. If a scene-list update removes it, the binding selects the first remaining scene. The existing document-level `meta.activeSceneId` remains readable for backward compatibility and persistence projection, but normal client navigation no longer writes or consumes it as the displayed scene.

Creating a scene remains one shared Yjs transaction. Before that transaction publishes its snapshot, the creating binding selects the new scene locally. Other bindings receive only the shared scene-list update and retain their own valid local selection.

Deleting a scene remains a shared document mutation. Every binding independently validates its local selection after receiving the updated scene list.

## Runtime and UI behavior

Scene navigation will be treated separately from durable document mutation guards. Timeline clicks and the existing Follow Guest action may call local `switchScene` even when the project runtime is read-only. Create/delete scene, node edits, and all other durable commands remain blocked in read-only mode.

Presence continues publishing each participant's local scene ID through Awareness. Existing same-scene peer filtering and Follow Guest behavior therefore continue without a new protocol or persistence field.

No scene selection is stored in `localStorage`, session storage, or the database. A new room starts on the first scene.

## Compatibility and error handling

- No database or Yjs schema migration is required.
- Existing documents containing `meta.activeSceneId` remain valid.
- Unknown or stale scene IDs are ignored by local switching.
- Empty or malformed scene lists continue using the existing default-scene normalization.
- Deleting the viewed scene always leaves the client on a valid first scene.
- No dependency is added.

## Testing

Implementation follows red-green-refactor.

Focused regression tests will prove:

1. Two synchronized bindings can display different scenes.
2. Switching one binding changes only its own visible nodes and active scene.
3. Local scene switching emits no Yjs update.
4. Creating a scene synchronizes the scene list while only the creator enters it.
5. Remote scene updates preserve another client's valid local scene.
6. Deleting the scene viewed by a client falls back to the first remaining scene.
7. Read-only runtime controls still allow local scene switching while durable commands remain blocked.

After focused tests pass, run the Spite test suite, lint/type checks available in the package, and review the final diff for unrelated changes and secrets.

## Out of scope

- Persisting a collaborator's last selected scene across refreshes or devices.
- Changing scene metadata from its existing array representation.
- Adding a server-side per-user preference.
- Automatically following another collaborator without an explicit Follow Guest action.
