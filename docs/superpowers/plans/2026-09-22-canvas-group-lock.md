# Canvas Group and Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable logical Group/Ungroup and Lock/Unlock behavior across every canvas mutation path without native React Flow parent groups.

**Architecture:** Persist only `data.groupId?: string` and `data.objectLocked?: boolean`. Pure helpers expand group selection, calculate mutation permission, derive React Flow capabilities, and remap copied groups. Yjs commands apply group/lock changes atomically; UI checks prevent side effects before guarded binding commands run.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.7, React Flow 12, Yjs 13, Hocuspocus, Node test runner through `tsx`.

## Global Constraints

- Execute after the correctness and utilities plans.
- Do not create React Flow parent/group nodes, `parentId`, relative coordinates, visual group frames, nesting, group titles, database records, dependencies, or migrations.
- Group membership is active-scene logical membership only.
- Persistent object locks are separate from transient collaborator ownership leases.
- Locked objects remain selectable, copyable, downloadable, previewable, and unlockable.
- If any member is locked, mutating the entire logical group is blocked.
- Duplicate/paste remaps each copied source group to a fresh group ID.
- Keep generic node-data persistence and projection.
- Disable React Flow's default Delete/Backspace path so application guards are authoritative.
- Notion MCP was unavailable during planning. Retry before execution and record unavailability without inventing task state.
- After the slice, update the selected Notion task status and implementation note if connected; otherwise report the exact Notion blocker.
- Preserve unrelated changes and stage exact paths only.

---

### Task 1: Define Pure Group, Lock, Selection, and Copy Semantics

**Files:**
- Create: `nexoclip-app/services/spite/lib/canvas-object-operations.ts`
- Create: `nexoclip-app/services/spite/lib/canvas-object-operations.test.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-selection.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-selection.test.ts`

**Interfaces:**

```ts
export type CanvasObjectNode = Pick<Node, 'id' | 'data'>

export type CanvasMutationKind =
  | 'move'
  | 'resize'
  | 'edit'
  | 'connect'
  | 'disconnect'
  | 'arrange'
  | 'delete'
  | 'group'
  | 'ungroup'

export type CanvasMutationDecision = {
  kind: CanvasMutationKind
  nodeIds: string[]
  lockedNodeIds: string[]
  allowed: boolean
}

export function readGroupId(node: CanvasObjectNode): string | undefined
export function isObjectLocked(node: CanvasObjectNode): boolean
export function expandNodeIdsToGroups(
  requestedNodeIds: readonly string[],
  activeSceneNodes: readonly CanvasObjectNode[],
): string[]
export function resolveNodeMutation(
  kind: CanvasMutationKind,
  requestedNodeIds: readonly string[],
  activeSceneNodes: readonly CanvasObjectNode[],
): CanvasMutationDecision
export function getCanvasNodeCapabilities(
  nodeId: string,
  activeSceneNodes: readonly CanvasObjectNode[],
  allowDocumentMutation: boolean,
): {
  draggable: boolean
  connectable: boolean
  deletable: boolean
  selectable: true
}
export function planNodeCopies<T extends Node>(
  requestedNodeIds: readonly string[],
  activeSceneNodes: readonly T[],
  options: {
    createNodeId: () => string
    createGroupId: () => string
    offset: { x: number; y: number }
  },
): {
  sourceNodeIds: string[]
  copies: T[]
  idMap: ReadonlyMap<string, string>
}
```

Update selection signature:

```ts
export function reconcileSelectedNodeIds(
  previous: string[],
  changes: NodeChange[],
  visibleNodes: readonly CanvasObjectNode[],
): string[]
```

- [ ] **Step 1: Add failing group-selection tests**

Add to `canvas-selection.test.ts`:

```ts
const visibleNodes = [
  { id: 'a', data: { sceneId: 'scene-1', groupId: 'group-1' } },
  { id: 'b', data: { sceneId: 'scene-1', groupId: 'group-1' } },
  { id: 'c', data: { sceneId: 'scene-1' } },
] as any

test('selecting one member selects the complete visible group', () => {
  assert.deepEqual(
    reconcileSelectedNodeIds([], [selectChange('a', true)], visibleNodes),
    ['a', 'b'],
  )
})

test('explicit deselection removes the complete group', () => {
  assert.deepEqual(
    reconcileSelectedNodeIds(
      ['a', 'b', 'c'],
      [selectChange('a', false)],
      visibleNodes,
    ),
    ['c'],
  )
})

test('selection expansion never crosses the supplied active-scene nodes', () => {
  assert.deepEqual(
    reconcileSelectedNodeIds(
      [],
      [selectChange('a', true)],
      visibleNodes.filter(node => node.id !== 'b'),
    ),
    ['a'],
  )
})
```

- [ ] **Step 2: Run and confirm RED**

Run from `nexoclip-app/services/spite`:

```bash
rtk npx tsx --test lib/canvas-selection.test.ts
```

- [ ] **Step 3: Add failing mutation and copy tests**

Create `canvas-object-operations.test.ts`:

```ts
test('a locked member blocks every mutation for its complete group', () => {
  const nodes = [
    { id: 'a', data: { groupId: 'g' } },
    { id: 'b', data: { groupId: 'g', objectLocked: true } },
    { id: 'c', data: {} },
  ] as any

  for (const kind of [
    'move', 'resize', 'edit', 'connect', 'disconnect',
    'arrange', 'delete', 'group', 'ungroup',
  ] as const) {
    assert.deepEqual(resolveNodeMutation(kind, ['a'], nodes), {
      kind,
      nodeIds: ['a', 'b'],
      lockedNodeIds: ['b'],
      allowed: false,
    })
  }

  assert.deepEqual(getCanvasNodeCapabilities('a', nodes, true), {
    draggable: false,
    connectable: false,
    deletable: false,
    selectable: true,
  })
})

test('partial group copy expands and remaps membership', () => {
  let nodeIndex = 0
  let groupIndex = 0
  const nodes = [
    {
      id: 'a', type: 'prompt', position: { x: 0, y: 0 },
      data: { sceneId: 'scene-1', groupId: 'source', objectLocked: true },
    },
    {
      id: 'b', type: 'imageGen', position: { x: 100, y: 0 },
      data: { sceneId: 'scene-1', groupId: 'source' },
    },
  ] as Node[]

  const plan = planNodeCopies(['a'], nodes, {
    createNodeId: () => `copy-${++nodeIndex}`,
    createGroupId: () => `copied-group-${++groupIndex}`,
    offset: { x: 40, y: 40 },
  })

  assert.deepEqual(plan.sourceNodeIds, ['a', 'b'])
  assert.deepEqual(plan.copies.map(node => node.id), ['copy-1', 'copy-2'])
  assert.deepEqual(
    plan.copies.map(node => node.data.groupId),
    ['copied-group-1', 'copied-group-1'],
  )
  assert.equal(plan.copies[0].data.objectLocked, true)
  assert.deepEqual(plan.copies.map(node => node.position), [
    { x: 40, y: 40 },
    { x: 140, y: 40 },
  ])
})

test('separate source groups receive separate fresh group IDs', () => {
  let groupIndex = 0
  const nodes = [
    { id: 'a', type: 'prompt', position: { x: 0, y: 0 }, data: { groupId: 'g1' } },
    { id: 'b', type: 'prompt', position: { x: 1, y: 0 }, data: { groupId: 'g2' } },
  ] as Node[]
  const plan = planNodeCopies(['a', 'b'], nodes, {
    createNodeId: () => crypto.randomUUID(),
    createGroupId: () => `new-${++groupIndex}`,
    offset: { x: 0, y: 0 },
  })

  assert.deepEqual(plan.copies.map(node => node.data.groupId), ['new-1', 'new-2'])
})
```

- [ ] **Step 4: Run and confirm RED**

```bash
rtk npx tsx --test lib/canvas-object-operations.test.ts
```

- [ ] **Step 5: Implement pure helpers**

Required semantics:

- valid group ID is a non-empty string;
- object is locked only when `data.objectLocked === true`;
- preserve requested ID order and append expanded members in active-scene order;
- inspect locks only after expansion;
- keep `selectable: true` for locked objects;
- copy all members of a partially requested group;
- assign one new group ID per source group per copy operation;
- preserve `objectLocked` in ordinary copy/paste;
- never reuse source group IDs.

- [ ] **Step 6: Refactor selection reconciliation**

Apply all React Flow select changes first. Explicit selection of any member wins over sibling deselections in the same change batch; a batch containing only deselection for that group removes all members. Expand only after raw selection state is resolved. Preserve the previous array reference when the final IDs are unchanged.

- [ ] **Step 7: Run focused tests**

```bash
rtk npx tsx --test lib/canvas-object-operations.test.ts lib/canvas-selection.test.ts
```

- [ ] **Step 8: Commit Task 1**

```bash
rtk git add lib/canvas-object-operations.ts lib/canvas-object-operations.test.ts lib/canvas-selection.ts lib/canvas-selection.test.ts
rtk git commit -m "feat(canvas): define logical object semantics"
```

---

### Task 2: Add Atomic Yjs Group and Lock Commands

**Files:**
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`
- Modify: `nexoclip-app/services/spite/hooks/use-realtime-canvas.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-runtime-ui.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts`

**Interfaces:**

```ts
groupNodes(nodeIds: string[]): string | null
ungroupNodes(nodeIds: string[]): string[]
setNodesLocked(nodeIds: string[], locked: boolean): string[]
```

Add deterministic test option:

```ts
type ReactFlowBindingOptions = {
  createId?: () => string
  createGroupId?: () => string
}
```

- [ ] **Step 1: Add failing command tests**

Add to `react-flow-binding.test.ts`:

```ts
test('group and lock commands update complete groups atomically', () => {
  const doc = createCanvasDocument()
  upsertNode(doc, {
    id: 'a', type: 'prompt', position: { x: 0, y: 0 },
    data: { sceneId: 'scene-1' },
  })
  upsertNode(doc, {
    id: 'b', type: 'imageGen', position: { x: 100, y: 0 },
    data: { sceneId: 'scene-1' },
  })
  const binding = createReactFlowBinding(doc, {
    createGroupId: () => 'group-1',
  })
  let localTransactions = 0
  doc.on('afterTransaction', transaction => {
    if (transaction.origin === LOCAL_REACT_FLOW_ORIGIN) localTransactions += 1
  })

  assert.equal(binding.groupNodes(['a', 'b']), 'group-1')
  assert.equal(localTransactions, 1)
  assert.deepEqual(binding.setNodesLocked(['a'], true), ['a', 'b'])
  assert.equal(localTransactions, 2)

  let projection = readCanvasProjection(doc)
  assert.equal(findNode(projection, 'a').data.groupId, 'group-1')
  assert.equal(findNode(projection, 'b').data.objectLocked, true)

  assert.deepEqual(binding.setNodesLocked(['a'], false), ['a', 'b'])
  projection = readCanvasProjection(doc)
  assert.equal(findNode(projection, 'a').data.objectLocked, undefined)
  assert.equal(findNode(projection, 'b').data.objectLocked, undefined)
  binding.destroy()
})
```

Add a two-document replication test that groups, locks, serializes an update, applies it to a replica, unlocks from the replica, and applies that update back. Assert equal `groupId` and absence of `objectLocked` on both final projections.

- [ ] **Step 2: Add failing duplicate/internal-edge test**

Seed grouped nodes `a` and `b` plus edge `a-to-b`. Call `duplicateNodes(['a'])` with deterministic node/group ID factories. Assert:

```ts
assert.equal(copiedNodes.length, 2)
assert.equal(new Set(copiedNodes.map(node => node.data.groupId)).size, 1)
assert.notEqual(copiedNodes[0].data.groupId, 'source-group')
assert.equal(copiedEdges.length, 1)
assert.equal(copiedNodeIds.has(copiedEdges[0].source), true)
assert.equal(copiedNodeIds.has(copiedEdges[0].target), true)
```

- [ ] **Step 3: Run and confirm RED**

```bash
rtk npx tsx --test lib/realtime/react-flow-binding.test.ts
```

- [ ] **Step 4: Implement commands in one transaction each**

- `groupNodes`: expand active-scene groups, require at least two unlocked nodes, assign one generated ID, patch all members.
- `ungroupNodes`: expand selection, reject when any member is locked, remove `groupId` from all members.
- `setNodesLocked(true)`: expand selection and set `objectLocked: true`.
- `setNodesLocked(false)`: expand selection and remove `objectLocked`; unlocking bypasses the lock it removes.
- Return affected IDs; no-op returns `null` or `[]` according to signature.

Refactor `duplicateNodes` to use `planNodeCopies` and its `idMap`, preserving existing internal-edge duplication.

- [ ] **Step 5: Add binding-level defensive lock guards**

Before applying structural mutations, resolve the relevant active-scene group:

- position/dimension node changes;
- node patch/delete;
- edge create/connect/delete when either endpoint is locked;
- scene deletion when any scene node is locked.

Do not block `setNodesLocked(false)`. Do not block background reconciliation that completes an already-started generation; guard user structural commands, not provider-status synchronization fields.

- [ ] **Step 6: Propagate commands through runtime controls**

Add all three commands to:

1. `RealtimeCanvasCommands`;
2. `EMPTY_COMMANDS`;
3. room forwarding;
4. `READ_ONLY_COMMANDS` as no-op results;
5. invocation-time writable guards.

Extend `canvas-runtime-ui.test.ts` with one writable forwarding assertion and one read-only no-op assertion for each command.

- [ ] **Step 7: Run focused tests**

```bash
rtk npx tsx --test lib/realtime/react-flow-binding.test.ts lib/canvas-runtime-ui.test.ts
```

- [ ] **Step 8: Commit Task 2**

```bash
rtk git add lib/realtime/react-flow-binding.ts lib/realtime/react-flow-binding.test.ts hooks/use-realtime-canvas.ts lib/canvas-runtime-ui.ts lib/canvas-runtime-ui.test.ts
rtk git commit -m "feat(canvas): persist groups and object locks"
```

---

### Task 3: Wire Workspace Selection, Capabilities, Clipboard, and Delete

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-collaboration.tsx`
- Modify: `nexoclip-app/services/spite/lib/canvas-react-flow-props.test.ts`

**Interfaces:**
- Expose through collaboration context:

```ts
resolveNodeMutation(
  kind: CanvasMutationKind,
  nodeIds: readonly string[],
): CanvasMutationDecision
```

- [ ] **Step 1: Add failing React Flow wiring tests**

```ts
test('React Flow cannot bypass logical lock deletion', () => {
  assert.match(source, /deleteKeyCode=\{null\}/)
  assert.match(source, /getCanvasNodeCapabilities/)
  assert.match(source, /selectable:\s*true/)
})

test('logical grouping uses no native parent nodes', () => {
  assert.doesNotMatch(source, /parentId|parentNode|extent:\s*['"]parent['"]/)
})
```

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/canvas-react-flow-props.test.ts
```

- [ ] **Step 3: Make local selection group-aware**

Pass active-scene nodes to `reconcileSelectedNodeIds`. Normalize selection when remote `groupId` changes and when a shot is clicked. Continue clearing selection on pane click and scene switch.

Rename the existing awareness ownership variable from `lockedNodeIds` to `remoteOwnedNodeIds`; never serialize it as `objectLocked`.

- [ ] **Step 4: Derive React Flow capabilities**

Map every active-scene node through `getCanvasNodeCapabilities`. Persistent locks set `draggable`, `connectable`, and `deletable` false while keeping `selectable` true. Preserve existing stronger restrictions for remote ownership/read-only state.

Set:

```tsx
<ReactFlow deleteKeyCode={null} ... />
```

- [ ] **Step 5: Unify copy/paste and deletion**

- `Ctrl/Cmd+C`: expand partial groups before storing clipboard nodes; copying locked nodes remains allowed.
- Both paste paths: use one helper around `planNodeCopies` and assign fresh group IDs per paste.
- `Ctrl/Cmd+X`: resolve Delete for the expanded selection before changing the clipboard or deleting.
- `Ctrl/Cmd+D`: call the binding's group-aware `duplicateNodes`.
- `deleteSelected`: resolve the complete mutation before asset side effects or Yjs deletion.
- Scene deletion: reject if any scene node is persistently locked.
- Connections/cut: reject if source or target group is locked.

- [ ] **Step 6: Expose the decision helper in collaboration context**

The provider computes decisions from the latest active-scene nodes. Node components and action surfaces use the same helper before local state or network side effects. Keep existing command signatures unless a caller needs an affected-ID result.

- [ ] **Step 7: Run focused tests and type checking**

```bash
rtk npx tsx --test lib/canvas-object-operations.test.ts lib/canvas-selection.test.ts lib/canvas-react-flow-props.test.ts
rtk tsc --noEmit
```

- [ ] **Step 8: Commit Task 3**

```bash
rtk git add components/canvas/canvas-workspace.tsx components/canvas/canvas-collaboration.tsx lib/canvas-react-flow-props.test.ts
rtk git commit -m "feat(canvas): enforce grouped canvas actions"
```

---

### Task 4: Add Group/Lock Controls and Guard Direct Mutation Surfaces

**Files:**
- Create: `nexoclip-app/services/spite/lib/canvas-object-lock-wiring.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/node-toolbar.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/resizable-node-frame.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/resizable-node-frame.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/connected-inputs.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/edges/scissors-edge.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/shot-selector.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/generation-feedback.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/prompt-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/comment-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/sticker-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/compress-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/reference-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/image-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/video-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/utility-nodes.tsx`

- [ ] **Step 1: Write failing toolbar and guard source contracts**

Create `canvas-object-lock-wiring.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const toolbar = read('../components/canvas/nodes/node-toolbar.tsx')
const frame = read('../components/canvas/nodes/resizable-node-frame.tsx')

const guardedNodes = [
  'prompt-node.tsx', 'comment-node.tsx', 'sticker-node.tsx',
  'compress-node.tsx', 'reference-node.tsx', 'image-node.tsx',
  'video-node.tsx', 'utility-nodes.tsx',
].map(name => read(`../components/canvas/nodes/${name}`))

test('selection toolbar wires group and lock commands', () => {
  assert.match(toolbar, /commands\.groupNodes\(/)
  assert.match(toolbar, /commands\.ungroupNodes\(/)
  assert.match(toolbar, /commands\.setNodesLocked\([^,]+,\s*true\)/)
  assert.match(toolbar, /commands\.setNodesLocked\([^,]+,\s*false\)/)
  assert.match(toolbar, /Group/)
  assert.match(toolbar, /Ungroup/)
  assert.match(toolbar, /Unlock/)
})

test('resize and node editors consume the shared mutation decision', () => {
  assert.match(frame, /resolveNodeMutation/)
  for (const source of guardedNodes) assert.match(source, /resolveNodeMutation/)
})
```

- [ ] **Step 2: Add a failing resize guard test**

Extend the frame's pure/session test so a rejected `resize` decision creates no resize session and produces no persisted size patch. Keep this behavior in an exported small helper rather than requiring DOM tests.

- [ ] **Step 3: Run and confirm RED**

```bash
rtk npx tsx --test lib/canvas-object-lock-wiring.test.ts components/canvas/nodes/resizable-node-frame.test.ts
```

- [ ] **Step 4: Add toolbar actions**

Derive selected IDs from `getNodes().filter(node => node.selected)`, expand them, and compute one decision.

- Group: enabled for at least two expanded unlocked nodes.
- Ungroup: enabled when an expanded node has a group ID and the group is unlocked.
- Lock: set every expanded node locked.
- Unlock: clear locks from every expanded node; mixed selection displays Unlock.
- Delete and Arrange: disabled when blocked.
- Copy/Duplicate, Download, and fullscreen remain available for locked objects.
- Replace manual toolbar duplication with `commands.duplicateNodes(expandedIds)`.
- Toolbar Delete operates on the expanded selected IDs.

- [ ] **Step 5: Guard shared resize and edge surfaces**

- `ResizableNodeFrame`: reject before transient ownership claim or pointer capture; visually disable the handle.
- `ConnectedInputs`: guard one-edge and disconnect-all actions.
- `ScissorsEdge`: route through guarded edge deletion rather than raw binding deletion.
- `ShotSelector`: accept `disabled?: boolean`.
- Generation feedback retry: disable or reject while the node group is locked.

- [ ] **Step 6: Guard each node's user-initiated mutations**

Use `resolveNodeMutation('edit', [id])` or `resolveNodeMutation('resize', [id])` before local state/network work:

- Prompt: edit entry and text mutation.
- Comment: textarea/save/delete.
- Sticker: choosing a sticker.
- Utility Text/Sticky Note: editing and resize.
- Reference: rename/shot/folder/trust mutations and resize.
- Compress: upload/settings/compress and resize.
- Image/Video: rename, shot assignment, settings, generate/retry, trust/folder actions, and resize.

Allow existing background polling/upload reconciliation to settle an already-started job. Guard event handlers, not prop-sync effects.

When Image/Video creates extra batch-result nodes, explicitly omit `groupId` and `objectLocked` together with `shotId`; generated variants are not logical copies of the selected group.

- [ ] **Step 7: Run focused tests and type checking**

```bash
rtk npx tsx --test lib/canvas-object-lock-wiring.test.ts lib/canvas-object-operations.test.ts lib/canvas-selection.test.ts lib/canvas-react-flow-props.test.ts components/canvas/nodes/resizable-node-frame.test.ts
rtk tsc --noEmit
```

- [ ] **Step 8: Commit Task 4**

```bash
rtk git add lib/canvas-object-lock-wiring.test.ts components/canvas/connected-inputs.tsx components/canvas/edges/scissors-edge.tsx components/canvas/nodes/node-toolbar.tsx components/canvas/nodes/resizable-node-frame.tsx components/canvas/nodes/resizable-node-frame.test.ts components/canvas/nodes/shot-selector.tsx components/canvas/nodes/generation-feedback.tsx components/canvas/nodes/prompt-node.tsx components/canvas/nodes/comment-node.tsx components/canvas/nodes/sticker-node.tsx components/canvas/nodes/compress-node.tsx components/canvas/nodes/reference-node.tsx components/canvas/nodes/image-node.tsx components/canvas/nodes/video-node.tsx components/canvas/nodes/utility-nodes.tsx
rtk git commit -m "feat(canvas): wire group and lock controls"
```

---

### Task 5: Slice Verification

- [ ] **Step 1: Run complete checks**

```bash
rtk npm test
rtk npm run test:realtime
rtk npm run lint
rtk npm run build
```

- [ ] **Step 2: Confirm prohibited native grouping and schema changes are absent**

```bash
rtk grep -R -n -E "parentId|parentNode|extent:[[:space:]]*['\"]parent['\"]" components/canvas lib/canvas-object-operations.ts || true
rtk git diff HEAD~4 -- package.json pnpm-lock.yaml database-setup.sql app/api realtime/projector.ts lib/realtime/document.ts
```

Expected: no native parent grouping and no dependency/schema/projector changes.

- [ ] **Step 3: Review diff and secrets**

```bash
rtk git diff --check
rtk git status --short
rtk git diff HEAD~4 -- components/canvas hooks lib realtime
rtk git diff HEAD~4 | rtk grep -n -i "api[_-]key\|secret\|token" || true
```

- [ ] **Step 4: Perform two-tab manual acceptance**

1. Group two nodes and confirm selecting one selects/moves both.
2. Ungroup without changing positions.
3. Copy one apparent member and confirm the complete group pastes with a fresh group ID.
4. Duplicate connected grouped nodes and confirm copied internal edges target copies.
5. Paste twice and confirm independent group IDs.
6. Lock one node and a mixed group; test drag, keyboard move, resize, edit, rename, settings, generate, arrange, connect, disconnect, cut, Delete, toolbar trash, and scene deletion.
7. Confirm Copy, Download, fullscreen, selection, and Unlock remain available.
8. Reload/reconnect and confirm persistent locks remain.
9. Confirm transient collaborator ownership never writes `objectLocked`.
10. Confirm batch-generated Image/Video variants do not inherit group/lock metadata.
11. Confirm Utility Text and Sticky Note obey the same edit/resize rules.
