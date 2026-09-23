# Independent Collaborative Scene Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each collaborator on an independent local scene while continuing to synchronize scene definitions and canvas content through Yjs.

**Architecture:** Move the displayed `activeSceneId` into each `createReactFlowBinding` instance and derive visible nodes/edges from that client-local value. Yjs remains authoritative for scenes, nodes, and edges; local scene switches notify only local subscribers, while create/delete scene operations still synchronize document structure. Runtime guards will treat scene navigation as local UI state so read-only participants can navigate.

**Tech Stack:** TypeScript 5.7, React 19, Next.js 16, Yjs 13, Node test runner via `tsx`, pnpm

## Global Constraints

- Opening or refreshing a project selects the first available scene.
- Scene switching must not emit a Yjs update or change persistence status.
- Creating a scene synchronizes it but navigates only the creator.
- A removed active scene falls back to the first remaining scene.
- Follow Guest remains the only explicit cross-scene navigation action.
- Do not add localStorage, session storage, database fields, migrations, or dependencies.
- Preserve unrelated workspace changes.

---

## File Map

- `nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts`: owns the client-local active scene, local snapshot refresh, scene command semantics, and node default scene assignment.
- `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`: proves two bindings can navigate independently while shared scene mutations still converge.
- `nexoclip-app/services/spite/lib/canvas-runtime-ui.ts`: permits the local `switchScene` command while continuing to block durable commands in read-only mode.
- `nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts`: proves both runtime-control wrappers preserve read-only scene navigation.
- `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx`: removes the durable-mutation check from timeline navigation; Follow Guest continues through the now-local command.

### Task 1: Make active scene client-local in the Yjs binding

**Files:**
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts:94-168, 321-341, 432-453, 610-618, 648-650`
- Test: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`

**Interfaces:**
- Consumes: `readCanvasProjection(doc): CanvasProjection` and the existing `RealtimeCanvasBinding.switchScene(sceneId): void` API.
- Produces: the same public binding API, with `snapshot.activeSceneId` scoped to one binding and `switchScene` producing no Yjs transaction.

- [ ] **Step 1: Add failing independent-navigation regression tests**

Append focused tests that create separate Yjs replicas and separate bindings:

```ts
test('scene navigation stays local to each binding and emits no Yjs update', () => {
  const primary = createCanvasDocument()
  setScenes(primary, [
    { id: 'scene-1', name: 'Scene 1' },
    { id: 'scene-2', name: 'Scene 2' },
  ])
  // Legacy persisted navigation must not override the first-scene default.
  setActiveSceneId(primary, 'scene-2')
  upsertNode(primary, {
    id: 'scene-1-node',
    position: { x: 0, y: 0 },
    data: { sceneId: 'scene-1' },
  })
  upsertNode(primary, {
    id: 'scene-2-node',
    position: { x: 0, y: 0 },
    data: { sceneId: 'scene-2' },
  })

  const replica = new Y.Doc()
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(primary))
  const first = createReactFlowBinding(primary)
  const second = createReactFlowBinding(replica)
  let primaryUpdates = 0
  primary.on('update', () => { primaryUpdates += 1 })

  first.switchScene('scene-2')

  assert.equal(first.getSnapshot().activeSceneId, 'scene-2')
  assert.deepEqual(first.getSnapshot().nodes.map((node) => node.id), ['scene-2-node'])
  assert.equal(second.getSnapshot().activeSceneId, 'scene-1')
  assert.deepEqual(second.getSnapshot().nodes.map((node) => node.id), ['scene-1-node'])
  assert.equal(primaryUpdates, 0)

  first.destroy()
  second.destroy()
})

test('shared scene mutations preserve valid remote selection and fall back after deletion', () => {
  const primary = createCanvasDocument()
  setScenes(primary, [
    { id: 'scene-1', name: 'Scene 1' },
    { id: 'scene-2', name: 'Scene 2' },
  ])
  const replica = new Y.Doc()
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(primary))
  const first = createReactFlowBinding(primary, { createSceneId: () => 'scene-3' })
  const second = createReactFlowBinding(replica)

  second.switchScene('scene-2')
  const createUpdate = captureUpdate(primary, () => {
    assert.equal(first.createScene('Scene 3'), 'scene-3')
  })
  Y.applyUpdate(replica, createUpdate, 'remote-sync')

  assert.equal(first.getSnapshot().activeSceneId, 'scene-3')
  assert.equal(second.getSnapshot().activeSceneId, 'scene-2')
  assert.deepEqual(second.getSnapshot().scenes.map((scene) => scene.id), [
    'scene-1',
    'scene-2',
    'scene-3',
  ])

  const deleteUpdate = captureUpdate(primary, () => first.deleteScene('scene-2'))
  Y.applyUpdate(replica, deleteUpdate, 'remote-sync')

  assert.equal(first.getSnapshot().activeSceneId, 'scene-3')
  assert.equal(second.getSnapshot().activeSceneId, 'scene-1')

  first.destroy()
  second.destroy()
})
```

- [ ] **Step 2: Run the focused binding test and verify RED**

Run from `nexoclip-app/services/spite`:

```bash
rtk pnpm exec tsx --test lib/realtime/react-flow-binding.test.ts
```

Expected: the first test fails because `switchScene` writes shared Yjs state; the second fails because a remote scene mutation replaces the replica's active scene with the shared `meta.activeSceneId`.

- [ ] **Step 3: Implement client-local scene selection**

In `createReactFlowBinding`, initialize from the first normalized scene and centralize snapshot refresh:

```ts
const listeners = new Set<() => void>()
const duplicateOffset = options.duplicateOffset ?? DEFAULT_DUPLICATE_OFFSET
let projection = readCanvasProjection(doc)
let activeSceneId = projection.scenes[0].id
let snapshot = deriveSnapshot(projection, activeSceneId)

const emitSnapshot = () => {
  for (const listener of listeners) listener()
}

const refreshSnapshot = () => {
  projection = readCanvasProjection(doc)
  if (!projection.scenes.some((scene) => scene.id === activeSceneId)) {
    activeSceneId = projection.scenes[0].id
  }
  snapshot = deriveSnapshot(projection, activeSceneId)
  emitSnapshot()
}

const handleUpdate = () => {
  refreshSnapshot()
}
```

Update raw scene mutations so only scene structure is shared:

```ts
createScene(name) {
  const nextId = options.createSceneId?.() ?? createSceneId()
  const scenes = readCanvasProjection(doc).scenes
  activeSceneId = nextId
  setScenesRecord(doc, [...scenes, { id: nextId, name: name ?? nextSceneName(scenes) }])
  return nextId
},

switchScene(sceneId) {
  if (!readCanvasProjection(doc).scenes.some((scene) => scene.id === sceneId)) return
  activeSceneId = sceneId
},
```

Make the public switch command local-only and keep batch-local switches observable:

```ts
switchScene(sceneId) {
  const previousSceneId = activeSceneId
  rawMutations.switchScene(sceneId)
  if (activeSceneId !== previousSceneId) refreshSnapshot()
},

batch(callback) {
  const previousSceneId = activeSceneId
  runLocalTransaction(doc, () => callback(rawMutations))
  if (activeSceneId !== previousSceneId && snapshot.activeSceneId !== activeSceneId) {
    refreshSnapshot()
  }
},
```

Change snapshot derivation to accept the already-read projection and local scene ID:

```ts
function deriveSnapshot(
  projection: CanvasProjection,
  activeSceneId: string,
): RealtimeCanvasBindingSnapshot {
  const allNodes = projection.nodes.map((node) => ({ ...node, data: { ...ensureRecord(node.data) } }))
  // retain the existing node/edge filtering and return shape
}
```

Replace every `readActiveSceneId(doc)` use inside the binding with the closure's `activeSceneId`, then remove `readActiveSceneId` and `setActiveSceneRecord`. Keep the `meta.activeSceneId` maintenance inside `deleteSceneRecord` for backward-compatible document validity only.

- [ ] **Step 4: Run the focused binding test and verify GREEN**

```bash
rtk pnpm exec tsx --test lib/realtime/react-flow-binding.test.ts
```

Expected: all tests in the file pass; independent switch emits zero Yjs updates, scene create converges without pulling the other binding, and deleted-scene fallback selects `scene-1`.

- [ ] **Step 5: Review and commit the binding change**

```bash
rtk git diff -- nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts
rtk git add nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts
rtk git commit -m "fix(canvas): keep scene navigation local"
```

### Task 2: Allow local scene navigation in read-only mode

**Files:**
- Modify: `nexoclip-app/services/spite/lib/canvas-runtime-ui.ts:20-39, 86-100, 102-137`
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx:1218-1226`
- Test: `nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts:50-184`

**Interfaces:**
- Consumes: Task 1's local-only `RealtimeCanvasCommands.switchScene(sceneId): void`.
- Produces: `guardCanvasRuntimeControls` and `createInvocationTimeRuntimeControls` wrappers that always forward `switchScene` while still blocking every durable command under `READ_ONLY`.

- [ ] **Step 1: Add failing read-only navigation assertions**

In the invocation-time test, invoke the captured scene command after changing the status to read-only and assert that it is forwarded:

```ts
statusRef.current = 'READ_ONLY'
capturedCommands.switchScene('scene-2')
capturedCommands.createNode(sampleNode)
// existing blocked calls remain
assert.deepEqual(calls, [
  'createNode',
  'batch',
  'batch.createNode',
  'undo',
  'redo',
  'switchScene',
])
```

In the static read-only controls test, invoke the scene command and expect only that call to survive:

```ts
const readOnlyControls = guardCanvasRuntimeControls(controls, 'READ_ONLY')
readOnlyControls.commands.switchScene('scene-2')
readOnlyControls.commands.createNode({})
// existing return-value assertions remain
assert.deepEqual(calls, ['switchScene'])
```

Update later expected call arrays in those tests to include the forwarded `switchScene` entry without allowing any durable command.

- [ ] **Step 2: Run the focused runtime-control test and verify RED**

```bash
rtk pnpm exec tsx --test lib/canvas-runtime-ui.test.ts
```

Expected: read-only assertions fail because both guard implementations currently replace `switchScene` with a no-op.

- [ ] **Step 3: Forward only local scene navigation through read-only guards**

Preserve the real command in the static guard:

```ts
return {
  ...controls,
  commands: {
    ...READ_ONLY_COMMANDS,
    switchScene: controls.commands.switchScene,
  },
  undo: () => {},
  redo: () => {},
}
```

Bypass the document-mutation `invoke` helper only for `switchScene` in invocation-time controls:

```ts
switchScene: (...args) => controlsRef.current.commands.switchScene(...args),
```

In `CanvasWorkspace`, remove the obsolete mutation check from the timeline callback:

```tsx
onSceneChange={(sceneId) => {
  commands.switchScene(sceneId)
  setSelectedNodeIds([])
}}
```

Keep create/delete scene checks unchanged because those commands still mutate shared Yjs state. Follow Guest already calls `commands.switchScene`, so no additional UI path is needed.

- [ ] **Step 4: Run focused runtime and binding tests and verify GREEN**

```bash
rtk pnpm exec tsx --test lib/canvas-runtime-ui.test.ts lib/realtime/react-flow-binding.test.ts
```

Expected: both files pass; read-only allows only local navigation and the realtime binding remains independent.

- [ ] **Step 5: Review and commit the runtime/UI change**

```bash
rtk git diff -- nexoclip-app/services/spite/lib/canvas-runtime-ui.ts nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx
rtk git add nexoclip-app/services/spite/lib/canvas-runtime-ui.ts nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx
rtk git commit -m "fix(canvas): allow read-only scene navigation"
```

### Task 3: Full verification and focused manual review

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: evidence that the complete Spite test, lint, and build boundaries remain healthy.

- [ ] **Step 1: Run the full Spite unit suite**

```bash
cd nexoclip-app/services/spite
rtk pnpm test
```

Expected: zero failed tests.

- [ ] **Step 2: Run realtime integration tests**

```bash
rtk pnpm run test:realtime
```

Expected: zero failed tests. If environment-dependent integration tests skip, record the exact skip output rather than claiming they ran.

- [ ] **Step 3: Run lint and production build**

```bash
rtk pnpm run lint
rtk pnpm run build
```

Expected: both commands exit successfully with no new error attributable to the changed files.

- [ ] **Step 4: Review only the intended diff and scan for secrets**

```bash
cd ../../..
rtk git diff HEAD~2 -- nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts nexoclip-app/services/spite/lib/canvas-runtime-ui.ts nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx
rtk proxy rg -n '(API_KEY|SECRET|TOKEN|PASSWORD)\s*=' nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts nexoclip-app/services/spite/lib/canvas-runtime-ui.ts nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx || true
```

Expected: only local-scene and read-only-navigation changes appear, with no credential assignment.

- [ ] **Step 5: Manual two-client smoke test when a local realtime stack is available**

Open the same project in two browser tabs, keep Tab B on Scene 1, switch Tab A to Scene 2, and confirm Tab B remains on Scene 1. Create a scene in Tab A and confirm it appears in Tab B without navigating Tab B. Use Follow Guest in Tab B and confirm that explicit action moves only Tab B.
