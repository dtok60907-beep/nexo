# Collaboration Prompt Persistence and Mention Integrity

**Date:** 2026-09-21
**Status:** Implemented; browser refresh validation pending

## Goal

Make prompt edits and mention chips durable and consistent across collaboration sessions, refreshes, reconnects, and generation.

A prompt that a user sees and edits must not revert to an older version after refresh, lose its `@mention` metadata, or generate using a different state than the visible editor.

## Reported Symptoms

- A user edits a prompt and sees the change locally.
- The prompt may look correct in the editor, including mention chips.
- Another collaborator may see an older prompt, or the same user sees an older prompt after refresh.
- Mention chips may become plain text without `@` or disappear after reload.
- Generation may run from stale prompt data and omit the intended reference images.

## Root Cause Model

The prompt editor has two representations:

1. The local `contentEditable` DOM/React state used to render chips and caret interactions.
2. The shared Yjs/React Flow node data persisted by the realtime runtime.

The local editor can visually update before the shared document is durably persisted. Generation currently reads the shared React Flow snapshot, not the editor DOM. A stale shared snapshot can therefore generate a prompt that differs from what the user sees. Refresh then correctly reloads the stale durable state, which appears to the user as an undo.

The fix must make persistence state explicit and must never claim that a local edit is saved before the authoritative Yjs state has accepted and persisted it.

## Product Rules

### Authoritative prompt state

For every prompt node, the durable shared node data is authoritative:

```text
node.data.text
node.data.mentions
```

A mention is not durable unless both its serialized `@tag` text and its mention metadata are present in the shared node data.

### Local editor behavior

The editor may optimistically render local changes for responsive typing, but it must:

- preserve the `@tag` in serialized text;
- preserve `folderId`, selected legacy IDs, and selected `workspaceAssetIds` in metadata;
- distinguish pending local changes from confirmed shared state;
- reconcile with remote state without silently discarding a newer local edit;
- show a saving/degraded state when persistence has not completed.

### Refresh and reconnect

After refresh or reconnect:

- the editor hydrates from the durable Yjs document;
- the latest durable prompt and mention metadata are restored together;
- an older snapshot must not overwrite a newer durable update;
- a local pending edit may be restored only if it has a matching client transaction/version and has not been rejected;
- no mention chip may be rendered from local-only state after the editor has completed hydration.

### Generation safety

Generation must not submit a stale prompt:

- generation is disabled while the prompt node has an unpersisted local edit;
- or the submit flow waits for persistence and then reads the latest authoritative node state;
- generation must use the same `text` and `mentions` version that the user sees as saved;
- if persistence is degraded/read-only, generation must stop with an actionable error instead of submitting stale state;
- a generated request with an `@mention` must include the references compiled from the authoritative mention metadata.

## Proposed Design

### 1. Version local prompt edits

Track a local prompt state key/version containing:

```text
nodeId + serialized text + normalized mentions
```

When `MentionTextarea` emits a change:

1. update the local display immediately;
2. write `text` and `mentions` in one Yjs transaction through `patchNodeData`;
3. mark that state as pending;
4. clear the local pending key only after the shared projection echoes that exact text-and-mentions key; generation separately verifies persistence through runtime status and a server-side durable-state comparison.

A metadata-only mention update must be treated as a real state change even when the serialized text is unchanged.

### 2. Prevent stale prop synchronization

The prompt node must not apply an incoming remote value over a newer pending local value merely because React re-rendered.

Remote state may replace local state only when:

- there is no pending local edit;
- the incoming state is confirmed newer; or
- the local edit was explicitly rejected and the UI reports the rejection.

The comparison must include both `text` and normalized `mentions`, not text alone.

### 3. Persist prompt text and mention metadata atomically

`text` and `mentions` must be patched in the same Yjs transaction. There must be no observable durable state containing the new text with old mention metadata or old text with new metadata.

### 4. Make persistence status actionable

The prompt editor/generation node must expose these states:

```text
SYNCED         → connected with no known write in flight
PERSISTING     → update is being written
PERSISTED      → the originating connection received a durable ACK
DEGRADED       → persistence failed or connection lost
READ_ONLY      → mutations are blocked
```

The UI may use a compact indicator, but Generate must use the status programmatically.

### 5. Generation submit handshake

Before generation:

1. identify the connected prompt node;
2. block while status is `PERSISTING`, `DEGRADED`, or `READ_ONLY`;
3. send a deterministic key for the raw prompt text and normalized mention metadata;
4. flush/export the latest authoritative document on the server;
5. compare the submitted key with the connected durable Prompt node;
6. submit only when the keys match; otherwise return `PROMPT_STATE_NOT_PERSISTED` before provider work.

If the state changes during the handshake, abort and ask the user to retry rather than mixing versions.

The server must continue validating project ownership and reference ownership. This task does not weaken asset Trust or canonical reference validation.

## Error Handling

- Persistence not complete: do not submit; show `Prompt is still saving. Try again in a moment.`
- Realtime degraded/read-only: do not submit; show a reconnect/read-only message.
- Remote conflict while editing: retain the local draft, show a conflict state, and require explicit reload/merge rather than silently reverting.
- Missing mention metadata for a serialized `@tag`: treat it as unresolved and prevent generation when that tag is expected to provide references.
- Failed authoritative refresh: preserve the local draft in the editor but clearly mark it unsaved; never report it as saved.

## Testing Plan

Add regression coverage for:

1. Local prompt text and mention chip are persisted in one shared transaction.
2. Metadata-only mention changes propagate even when text is unchanged.
3. A remote stale snapshot cannot overwrite a newer pending local edit.
4. Refresh restores the latest text and all mention metadata.
5. Reconnect/hydration does not turn a durable mention chip into plain text.
6. A prompt with a local pending edit cannot generate.
7. Generation blocks while persistence is in flight and the server rejects any prompt-state key that differs from the latest durable text/mentions.
8. Generation is rejected while persistence is `DEGRADED` or `READ_ONLY`.
9. Two collaborators converge on identical `text` and `mentions` after editing.
10. A generated request contains the expected reference URLs for every durable mention.
11. A stale local version cannot submit a prompt after another collaborator has committed a newer version.
12. Existing prompt editing, caret, chip selection, and folder filtering behavior remains intact.

## Scope

This task covers prompt state durability, mention metadata integrity, collaboration convergence, and generation gating.

It does not change:

- asset identity rules;
- BytePlus Trust semantics;
- project-scoped asset ownership;
- provider payload rules for trusted/untrusted assets;
- legacy asset migration policy.

## Acceptance Criteria

- A saved prompt never reverts after refresh.
- A saved mention chip remains a chip after refresh and reconnect.
- Text and mention metadata converge for all collaborators.
- Generate cannot use a prompt state that is only local or not persisted.
- Generation uses the same durable prompt and mention state the user sees.
- A failed/degraded persistence state is visible and prevents paid generation.
- Existing canonical asset and Trust validation remains unchanged.

## Implemented Changes

- Prompt drafts remain pending after blur until the exact shared state echoes them.
- Local Yjs mutations, including undo/redo, immediately mark the canvas `PERSISTING` before the server status round trip.
- Pending local update counts prevent an older ACK from marking a newer draft persisted; successful reconnect resets transaction counting because state-vector sync may send one or zero updates.
- The local prompt key is retained through the durable ACK, not merely the optimistic local Yjs echo.
- A settled divergent CRDT result is surfaced as a conflict and replaces the local-only view before generation.
- Refresh/navigation warns while state is `PERSISTING`, `DEGRADED`, or `READ_ONLY`.
- `selectedWorkspaceAssetIds` participate in mention-state identity.
- Image and video generation use freshly resolved prompt mention metadata rather than a stale render closure.
- Prompt editing is disabled in `READ_ONLY` state.
- Generation controls are disabled during `PERSISTING`, `DEGRADED`, and `READ_ONLY` states.
- Generation requests include `promptStateKey`.
- New mention chips persist canonical `selectedWorkspaceAssetIds`; same-count folder metadata refreshes emit metadata-only prompt updates.
- Complete canonical mention IDs compile without waiting for the local folder cache to refresh; partial/legacy-only identity fails safely instead of omitting selected assets.
- The submit route flushes/exports authoritative realtime state and returns HTTP 409 with `PROMPT_STATE_NOT_PERSISTED` when the connected Prompt node is missing or the submitted key does not match.
- Seedance submission also verifies every durable mention has complete canonical identity and every mentioned `workspaceAssetId` is present in the submitted reference set before provider work.
