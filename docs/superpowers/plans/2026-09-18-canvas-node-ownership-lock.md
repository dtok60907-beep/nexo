# Canvas Node Ownership Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Canvas node exclusively editable by one active collaborator and restrict all video generation to 9:16.

**Architecture:** Replace the prompt-only server lease with a generic per-node lease. Canvas claims it before any mutating gesture and publishes active ownership through Yjs awareness, rendering a locked node as realtime view-only for other participants. The server lease remains authoritative. Video node normalizes its aspect ratio to 9:16 and submit validates it.

**Tech Stack:** Next.js App Router, PostgreSQL, React Flow, React, TypeScript, Yjs.

## Global Constraints

- Lock scope is one Canvas node, never the whole project.
- The lock covers Prompt, Image, Video, and Reference nodes.
- Lease expiry is 15 seconds and heartbeat is 5 seconds.
- Non-owners receive realtime updates but cannot mutate a locked node.
- Lock API/network failures must remain local recoverable UI errors; never reload Canvas.
- Video aspect ratio is always `9:16`; image settings are unchanged.

---

### Task 1: Generic server node lock lease

**Files:**
- Modify: `services/spite/lib/prompt-editor-lock.ts`
- Modify: `services/spite/app/api/projects/[projectId]/prompt-editor-lock/route.ts`
- Test: `services/spite/lib/prompt-editor-lock.test.ts`

**Interfaces:** Produces `claimCanvasNodeLock`, `heartbeatCanvasNodeLock`, and `releaseCanvasNodeLock` accepting `{ projectId, nodeId, participantId, userId }`.

- [ ] **Step 1: Add failed tests for claim conflict, same-owner renewal, and expired takeover.**
- [ ] **Step 2: Rename the table to `canvas_node_locks`, preserving the `(project_id, node_id)` primary key and `expires_at` lease.**
- [ ] **Step 3: Rename generic functions while retaining temporary prompt aliases for callers during migration.**
- [ ] **Step 4: Run `./node_modules/.bin/tsx --test lib/prompt-editor-lock.test.ts`.**
- [ ] **Step 5: Commit `feat(canvas): generalize node ownership locks`.**

### Task 2: Claim and enforce locks for Canvas mutations

**Files:**
- Modify: `services/spite/components/canvas/canvas-workspace.tsx`
- Modify: `services/spite/components/canvas/canvas-collaboration.tsx`
- Modify: `services/spite/components/canvas/nodes/resizable-node-frame.tsx`
- Modify: `services/spite/components/canvas/nodes/node-toolbar.tsx`
- Modify: `services/spite/components/canvas/nodes/prompt-node.tsx`
- Modify: `services/spite/components/canvas/nodes/image-node.tsx`
- Modify: `services/spite/components/canvas/nodes/video-node.tsx`
- Modify: `services/spite/components/canvas/nodes/reference-node.tsx`
- Create: `services/spite/hooks/use-node-ownership-lock.ts`
- Test: `services/spite/lib/canvas-node-interactions.test.ts`

**Interfaces:** `useNodeOwnershipLock({ projectId, nodeId })` returns `{ lockedByOther, claim, release, error }`. `claim()` must resolve true before a mutation is persisted. It publishes `{ activeNodeId, mode }` to Yjs awareness while owned and derives `lockedByOther` from other participants' awareness states.

- [ ] **Step 1: Add failing interaction tests showing a non-owner cannot drag, resize, delete, submit, edit settings, or connect a locked node but can work on another node.**
- [ ] **Step 2: Implement the hook with POST `claim`, 5-second heartbeat, release on unmount/gesture completion, local error state, and existing Yjs awareness `{ activeNodeId, mode }` publication.**
- [ ] **Step 3: Guard React Flow drag/connect events and node frame resize against a failed claim.**
- [ ] **Step 4: Disable each node's toolbar/settings/editor/handles for non-owners and display `Being edited by another collaborator.`**
- [ ] **Step 5: Preserve Prompt blur/Escape release and migrate it to the generic hook.**
- [ ] **Step 6: Run focused Canvas interaction and realtime tests; commit `fix(canvas): lock node interactions per collaborator`.**

### Task 3: Portrait-only video state and submit validation

**Files:**
- Modify: `services/spite/components/canvas/nodes/video-node.tsx`
- Modify: `services/spite/app/api/generate/submit/route.ts`
- Modify: `src/providers/direct/byteplusAdapter.js`
- Test: `services/spite/lib/task-17-server-writers.test.ts`
- Test: `tests/generations/saasVideoGeneration.test.mjs`

**Interfaces:** Video node and submit payload always use `{ aspectRatio: '9:16' }`; non-`9:16` video payload receives 400.

- [ ] **Step 1: Add a failing submit test for a video request with `16:9`, expecting 400, and a `9:16` request expecting preserved portrait settings.**
- [ ] **Step 2: Initialize, synchronize, and persist Video node `aspectRatio` as `9:16`; remove its ratio selector and make model changes retain it.**
- [ ] **Step 3: In submit route, reject a supplied non-`9:16` video setting and assign `parameters.aspectRatio = '9:16'`.**
- [ ] **Step 4: Emit BytePlus native `{ ratio: '9:16' }`, not `aspect_ratio`, for Seedance requests.**
- [ ] **Step 5: Run focused submit/worker tests; commit `fix(video): enforce portrait generation`.**

### Task 4: Verify, deploy, and validate two-user behavior

**Files:** No source changes.

- [ ] **Step 1: Run all focused lock, Canvas, submit, and worker tests plus `git diff --check`.**
- [ ] **Step 2: Deploy `ai-ugc-spite`, `ai-ugc-spite-realtime`, and `ai-ugc-video-worker`; wait for SUCCESS.**
- [ ] **Step 3: Hard refresh both browser clients with Cmd+Shift+R.**
- [ ] **Step 4: Verify User 1 editing Prompt A locks every Prompt A action for User 2 while User 2 edits Video B normally.**
- [ ] **Step 5: Verify blur/release and 15-second expiry permit User 2 to claim Prompt A.**
- [ ] **Step 6: Verify Video node offers no non-9:16 ratio and a generated Seedance request uses `ratio: '9:16'`.**
