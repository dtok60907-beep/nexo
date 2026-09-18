import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'

import {
  createCanvasDocument,
  readCanvasProjection,
  setActiveSceneId,
  setScenes,
  upsertEdge,
  upsertNode,
} from './document'
import { completeGenerationNode } from '../generation-node'
import { LOCAL_REACT_FLOW_ORIGIN, createReactFlowBinding } from './react-flow-binding'
import {
  getOrCreateRealtimeCanvasRoom,
  releaseRealtimeCanvasRoom,
  resolveRealtimeWebsocketUrl,
} from '../../hooks/use-realtime-canvas'

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000'

class FakeAwareness {
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly states = new Map<number, Record<string, unknown>>()

  on(event: 'change' | 'update', listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event: 'change' | 'update', listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  getStates(): Map<number, Record<string, unknown>> {
    return new Map(this.states)
  }

  setState(clientId: number, state: Record<string, unknown>): void {
    this.states.set(clientId, state)
  }

  emit(event: 'change' | 'update'): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener()
    }
  }

  destroy(): void {
    this.listeners.clear()
    this.states.clear()
  }
}

class FakeProvider {
  readonly awareness = new FakeAwareness()
  readonly document: Y.Doc
  readonly token: string | (() => Promise<string>) | null
  readonly onStateless: (event: { payload: string }) => void
  destroyed = false

  constructor(configuration: {
    document: Y.Doc
    token: string | (() => Promise<string>) | null
    onStateless: (event: { payload: string }) => void
    onAwarenessChange?: () => void
    onAwarenessUpdate?: () => void
  }) {
    this.document = configuration.document
    this.token = configuration.token
    this.onStateless = configuration.onStateless
    if (configuration.onAwarenessChange) {
      this.awareness.on('change', configuration.onAwarenessChange)
    }
    if (configuration.onAwarenessUpdate) {
      this.awareness.on('update', configuration.onAwarenessUpdate)
    }
  }

  async requestToken(): Promise<string | null> {
    if (typeof this.token === 'function') {
      return this.token()
    }
    return this.token
  }

  emitStateless(payload: string): void {
    this.onStateless({ payload })
  }

  destroy(): void {
    this.destroyed = true
    this.awareness.destroy()
  }
}

function findNode(projection: ReturnType<typeof readCanvasProjection>, nodeId: string) {
  const node = projection.nodes.find((candidate) => candidate.id === nodeId)
  assert.ok(node, `expected node ${nodeId} to exist`)
  return node
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  let captured: Uint8Array | null = null
  const handleUpdate = (update: Uint8Array) => {
    captured = new Uint8Array(update)
  }

  doc.on('update', handleUpdate)
  mutate()
  doc.off('update', handleUpdate)

  assert.ok(captured, 'expected mutation to emit a Yjs update')
  return captured
}

test('binding writes local React Flow changes into Yjs while retaining hidden-scene state', () => {
  const doc = createCanvasDocument()
  setScenes(doc, [
    { id: 'scene-1', name: 'Scene 1' },
    { id: 'scene-2', name: 'Scene 2' },
  ])
  setActiveSceneId(doc, 'scene-1')

  upsertNode(doc, {
    id: 'node-1',
    type: 'prompt',
    position: { x: 10, y: 20 },
    data: { sceneId: 'scene-1', label: 'Visible' },
  })
  upsertNode(doc, {
    id: 'node-2',
    type: 'prompt',
    position: { x: 30, y: 40 },
    data: { sceneId: 'scene-2', label: 'Hidden' },
  })
  upsertEdge(doc, {
    id: 'edge-hidden',
    source: 'node-2',
    target: 'node-2',
    data: { label: 'retained' },
  })

  const binding = createReactFlowBinding(doc)
  const initialSnapshot = binding.getSnapshot()
  const snapshots = [initialSnapshot]
  const unsubscribe = binding.subscribe(() => {
    snapshots.push(binding.getSnapshot())
  })

  binding.createNode({
    id: 'node-3',
    type: 'comment',
    position: { x: 50, y: 60 },
    selected: true,
    dragging: true,
    measured: { width: 120, height: 80 },
    data: { sceneId: 'scene-1', label: 'New node' },
  } as any)
  binding.applyNodeChanges([
    {
      type: 'position',
      id: 'node-1',
      position: { x: 70, y: 80 },
      dragging: true,
    },
  ] as any)

  const projection = readCanvasProjection(doc)
  assert.equal(findNode(projection, 'node-1').position.x, 70)
  assert.equal(findNode(projection, 'node-1').position.y, 80)
  assert.ok(projection.nodes.some((node) => node.id === 'node-2'))
  assert.ok(projection.edges.some((edge) => edge.id === 'edge-hidden'))

  const rawNode = doc.getMap<Y.Map<unknown>>('nodes').get('node-3')
  assert.ok(rawNode instanceof Y.Map)
  assert.equal(rawNode.get('selected'), undefined)
  assert.equal(rawNode.get('dragging'), undefined)
  assert.equal(rawNode.get('measured'), undefined)

  const latestSnapshot = binding.getSnapshot()
  assert.deepEqual(
    latestSnapshot.nodes.map((node) => node.id).sort(),
    ['node-1', 'node-3'],
  )
  assert.deepEqual(latestSnapshot.edges, [])
  assert.notEqual(latestSnapshot.nodes, snapshots[0].nodes)

  unsubscribe()
  binding.destroy()
})

test('binding ignores repeated React Flow measurements and positions that do not change durable state', () => {
  const doc = createCanvasDocument()
  upsertNode(doc, {
    id: 'measured-node',
    type: 'prompt',
    position: { x: 10, y: 20 },
    width: 320,
    height: 180,
    data: { sceneId: 'scene-1' },
  })

  const binding = createReactFlowBinding(doc)
  let documentUpdates = 0
  doc.on('update', () => {
    documentUpdates += 1
  })

  binding.applyNodeChanges([
    { type: 'position', id: 'measured-node', position: { x: 10, y: 20 }, dragging: false },
    { type: 'dimensions', id: 'measured-node', dimensions: { width: 320, height: 180 }, setAttributes: true },
  ] as any)
  binding.patchNodeData('measured-node', { sceneId: 'scene-1' })
  binding.updateNodeData('measured-node', (data) => ({ ...data }))

  assert.equal(documentUpdates, 0)
  binding.destroy()
})

test('binding supports every durable canvas mutation category on the authoritative Yjs document', () => {
  const doc = createCanvasDocument()
  setScenes(doc, [
    { id: 'scene-1', name: 'Scene 1' },
    { id: 'scene-2', name: 'Scene 2' },
  ])
  setActiveSceneId(doc, 'scene-1')

  upsertNode(doc, {
    id: 'source',
    type: 'imageGen',
    position: { x: 10, y: 20 },
    data: { sceneId: 'scene-1', label: 'Source', shotId: 'shot-1' },
  })
  upsertNode(doc, {
    id: 'target',
    type: 'videoGen',
    position: { x: 200, y: 120 },
    data: { sceneId: 'scene-1', label: 'Target' },
  })
  upsertNode(doc, {
    id: 'hidden',
    type: 'reference',
    position: { x: 20, y: 30 },
    data: { sceneId: 'scene-2', label: 'Hidden', shotId: 'shot-2' },
  })

  const binding = createReactFlowBinding(doc, {
    createId: (() => {
      let i = 0
      return () => `generated-${++i}`
    })(),
    duplicateOffset: { x: 40, y: 40 },
  })

  const initial = binding.getSnapshot()
  assert.deepEqual(initial.nodes.map((node) => node.id).sort(), ['source', 'target'])
  assert.deepEqual(initial.allNodes.map((node) => node.id).sort(), ['hidden', 'source', 'target'])
  assert.deepEqual(initial.allEdges, [])

  binding.applyNodeChanges([
    { type: 'position', id: 'source', position: { x: 70, y: 90 }, dragging: true },
    { type: 'dimensions', id: 'source', dimensions: { width: 480, height: 320 }, setAttributes: true },
  ] as any)
  binding.createNode({
    id: 'comment-1',
    type: 'comment',
    position: { x: 400, y: 240 },
    data: { sceneId: 'scene-1', text: 'hello' },
  })
  const connectedEdgeId = binding.connect({
    source: 'source',
    sourceHandle: 'image-out',
    target: 'target',
    targetHandle: 'image-in',
  })
  assert.equal(typeof connectedEdgeId, 'string')

  binding.patchNodeData('source', {
    outputUrl: '/image.png',
    status: 'completed',
  })

  binding.batch(({ patchNodeData, createNode, createEdge, deleteEdge }) => {
    patchNodeData('target', { shotId: 'shot-3' })
    patchNodeData('source', { shotId: 'shot-3', selectedShotId: undefined })
    createNode({
      id: 'clipboard-copy',
      type: 'comment',
      position: { x: 440, y: 280 },
      data: { sceneId: 'scene-1', text: 'pasted' },
    })
    createEdge({
      id: 'clipboard-edge',
      source: 'clipboard-copy',
      target: 'target',
      sourceHandle: 'prompt-out',
      targetHandle: 'prompt-in',
      data: {},
    })
    if (connectedEdgeId) {
      deleteEdge(connectedEdgeId)
    }
  })

  const duplicateIds = binding.duplicateNodes(['source', 'target'])
  assert.equal(duplicateIds.length, 2)

  binding.createEdge({
    id: 'cut-me',
    source: 'source',
    target: 'comment-1',
    sourceHandle: 'image-out',
    targetHandle: 'image-in',
    data: {},
  })
  binding.deleteEdge('cut-me')
  binding.deleteNode('comment-1')
  binding.deleteScene('scene-2')

  const projection = readCanvasProjection(doc)
  assert.deepEqual(projection.scenes.map((scene) => scene.id), ['scene-1'])
  assert.equal(projection.nodes.some((node) => node.id === 'hidden'), false)
  assert.equal(findNode(projection, 'source').position.x, 70)
  assert.equal(findNode(projection, 'source').position.y, 90)
  assert.equal(findNode(projection, 'source').width, 480)
  assert.equal(findNode(projection, 'source').height, 320)
  assert.equal(findNode(projection, 'source').data.outputUrl, '/image.png')
  assert.equal(findNode(projection, 'source').data.status, 'completed')
  assert.equal(findNode(projection, 'source').data.shotId, 'shot-3')
  assert.equal(findNode(projection, 'target').data.shotId, 'shot-3')
  assert.equal(projection.nodes.some((node) => node.id === 'clipboard-copy'), true)
  assert.equal(projection.nodes.some((node) => node.id === 'comment-1'), false)
  assert.equal(projection.edges.some((edge) => edge.id === 'clipboard-edge'), true)
  assert.equal(projection.edges.some((edge) => edge.id === 'cut-me'), false)
  assert.equal(projection.edges.some((edge) => edge.id === connectedEdgeId), false)

  const latest = binding.getSnapshot()
  assert.deepEqual(latest.nodes.map((node) => node.id).sort(), ['clipboard-copy', ...duplicateIds, 'source', 'target'].sort())
  assert.equal(latest.edges.some((edge) => edge.id === 'clipboard-edge'), true)
  assert.equal(latest.allNodes.some((node) => node.id === 'hidden'), false)
  assert.equal(latest.allEdges.some((edge) => edge.id === 'cut-me'), false)

  binding.destroy()
})

test('binding observers publish remote updates without writing them back', () => {
  const doc = createCanvasDocument()
  const binding = createReactFlowBinding(doc)
  const origins: Array<string | object | null | undefined> = []
  const snapshots: ReturnType<typeof binding.getSnapshot>[] = []

  doc.on('afterTransaction', (transaction) => {
    origins.push(transaction.origin)
  })

  const unsubscribe = binding.subscribe(() => {
    snapshots.push(binding.getSnapshot())
  })

  const remoteReplica = new Y.Doc()
  Y.applyUpdate(remoteReplica, Y.encodeStateAsUpdate(doc))
  const remoteUpdate = captureUpdate(remoteReplica, () => {
    upsertNode(remoteReplica, {
      id: 'remote-node',
      type: 'prompt',
      position: { x: 11, y: 22 },
      data: { sceneId: 'scene-1', label: 'Remote' },
    })
  })

  Y.applyUpdate(doc, remoteUpdate, 'remote-sync')

  const latestSnapshot = binding.getSnapshot()
  assert.equal(latestSnapshot.nodes.length, 1)
  assert.equal(latestSnapshot.nodes[0].id, 'remote-node')
  assert.deepEqual(origins, ['remote-sync'])
  assert.equal(snapshots.length, 1)

  unsubscribe()
  binding.destroy()
})

test('binding updateNodeData merges against authoritative node data so concurrent fields survive generation completion', () => {
  const doc = createCanvasDocument()
  upsertNode(doc, {
    id: 'node-1',
    type: 'imageGen',
    position: { x: 10, y: 20 },
    data: {
      sceneId: 'scene-1',
      label: 'Frame',
      prompt: 'hello',
      pendingRequestId: 'req-1',
    },
  })

  const binding = createReactFlowBinding(doc)

  const remoteReplica = new Y.Doc()
  Y.applyUpdate(remoteReplica, Y.encodeStateAsUpdate(doc))
  const remoteBinding = createReactFlowBinding(remoteReplica)
  const remoteUpdate = captureUpdate(remoteReplica, () => {
    remoteBinding.patchNodeData('node-1', {
      remoteOnly: 'keep-me',
    })
  })
  Y.applyUpdate(doc, remoteUpdate, 'remote-sync')

  binding.updateNodeData('node-1', (currentData) =>
    completeGenerationNode(currentData, '/generated.png'),
  )

  const projection = readCanvasProjection(doc)
  assert.deepEqual(findNode(projection, 'node-1').data, {
    sceneId: 'scene-1',
    label: 'Frame',
    prompt: 'hello',
    outputUrl: '/generated.png',
    remoteOnly: 'keep-me',
    status: 'completed',
    error: null,
  })

  remoteBinding.destroy()
  binding.destroy()
})

test('binding replaceShot and createNextShot read the latest document state and patch only shot fields', () => {
  const doc = createCanvasDocument()
  setScenes(doc, [
    { id: 'scene-1', name: 'Scene 1' },
    { id: 'scene-2', name: 'Scene 2' },
  ])
  upsertNode(doc, {
    id: 'node-a',
    type: 'imageGen',
    position: { x: 10, y: 20 },
    data: { sceneId: 'scene-1', shotId: 'shot-1', label: 'A', remoteOnly: 'keep-a' },
  })
  upsertNode(doc, {
    id: 'node-b',
    type: 'reference',
    position: { x: 40, y: 20 },
    data: { sceneId: 'scene-1', shotId: 'shot-2', label: 'B', remoteOnly: 'keep-b' },
  })
  upsertNode(doc, {
    id: 'node-c',
    type: 'videoGen',
    position: { x: 80, y: 20 },
    data: { sceneId: 'scene-2', shotId: 'shot-2', label: 'C', remoteOnly: 'keep-c' },
  })

  const binding = createReactFlowBinding(doc)

  const remoteReplica = new Y.Doc()
  Y.applyUpdate(remoteReplica, Y.encodeStateAsUpdate(doc))
  const remoteBinding = createReactFlowBinding(remoteReplica)
  const remoteUpdate = captureUpdate(remoteReplica, () => {
    remoteBinding.createNode({
      id: 'node-d',
      type: 'imageGen',
      position: { x: 120, y: 20 },
      data: { sceneId: 'scene-1', shotId: 'shot-3', label: 'D', remoteOnly: 'keep-d' },
    })
  })
  Y.applyUpdate(doc, remoteUpdate, 'remote-sync')

  binding.replaceShot('node-a', 'shot-2')
  const nextShot = binding.createNextShot('node-b')

  const projection = readCanvasProjection(doc)
  assert.equal(nextShot, 'shot-4')
  assert.deepEqual(findNode(projection, 'node-a').data, {
    sceneId: 'scene-1',
    shotId: 'shot-2',
    label: 'A',
    remoteOnly: 'keep-a',
  })
  assert.deepEqual(findNode(projection, 'node-b').data, {
    sceneId: 'scene-1',
    shotId: 'shot-4',
    label: 'B',
    remoteOnly: 'keep-b',
  })
  assert.deepEqual(findNode(projection, 'node-c').data, {
    sceneId: 'scene-2',
    shotId: 'shot-2',
    label: 'C',
    remoteOnly: 'keep-c',
  })
  assert.deepEqual(findNode(projection, 'node-d').data, {
    sceneId: 'scene-1',
    shotId: 'shot-3',
    label: 'D',
    remoteOnly: 'keep-d',
  })

  remoteBinding.destroy()
  binding.destroy()
})

test('concurrent node-data patches merge by field instead of overwriting the prompt', () => {
  const primary = createCanvasDocument()
  const first = createReactFlowBinding(primary)
  first.createNode({
    id: 'shared-prompt', type: 'prompt', position: { x: 0, y: 0 },
    data: { sceneId: 'scene-1', text: 'original', mentions: [] },
  })

  const replica = new Y.Doc()
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(primary))
  const second = createReactFlowBinding(replica)
  const promptUpdate = captureUpdate(primary, () => {
    first.patchNodeData('shared-prompt', {
      text: 'A changed the prompt',
      mentions: [{ folderId: 'nathan', name: 'Nathan', selectedAssetIds: ['asset-1'] }],
    })
  })
  const generationUpdate = captureUpdate(replica, () => {
    second.patchNodeData('shared-prompt', { generationStatus: 'succeeded' })
  })

  Y.applyUpdate(primary, generationUpdate, 'remote-sync')
  Y.applyUpdate(replica, promptUpdate, 'remote-sync')

  const expected = {
    sceneId: 'scene-1',
    text: 'A changed the prompt',
    mentions: [{ folderId: 'nathan', name: 'Nathan', selectedAssetIds: ['asset-1'] }],
    generationStatus: 'succeeded',
  }
  assert.deepEqual(findNode(readCanvasProjection(primary), 'shared-prompt').data, expected)
  assert.deepEqual(findNode(readCanvasProjection(replica), 'shared-prompt').data, expected)

  second.destroy()
  first.destroy()
})

test('concurrent prompt typing preserves both edits', () => {
  const primary = createCanvasDocument()
  const first = createReactFlowBinding(primary)
  first.createNode({
    id: 'shared-prompt', type: 'prompt', position: { x: 0, y: 0 },
    data: { sceneId: 'scene-1', text: 'Nathan', mentions: [] },
  })
  const replica = new Y.Doc()
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(primary))
  const second = createReactFlowBinding(replica)
  const firstUpdate = captureUpdate(primary, () => first.patchNodeData('shared-prompt', { text: 'Nathan walks' }))
  const secondUpdate = captureUpdate(replica, () => second.patchNodeData('shared-prompt', { text: 'Nathan waits' }))

  Y.applyUpdate(primary, secondUpdate, 'remote-sync')
  Y.applyUpdate(replica, firstUpdate, 'remote-sync')

  const firstText = String(findNode(readCanvasProjection(primary), 'shared-prompt').data.text)
  const secondText = String(findNode(readCanvasProjection(replica), 'shared-prompt').data.text)
  assert.equal(firstText, secondText)
  assert.match(firstText, /walks/)
  assert.match(firstText, /waits/)

  second.destroy()
  first.destroy()
})

test('concurrent mention additions preserve both selections', () => {
  const primary = createCanvasDocument()
  const first = createReactFlowBinding(primary)
  first.createNode({
    id: 'shared-prompt', type: 'prompt', position: { x: 0, y: 0 },
    data: { sceneId: 'scene-1', text: '@Nathan @Natasya', mentions: [] },
  })
  const replica = new Y.Doc()
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(primary))
  const second = createReactFlowBinding(replica)
  const firstUpdate = captureUpdate(primary, () => first.patchNodeData('shared-prompt', {
    mentions: [{ folderId: 'nathan', name: 'Nathan', selectedAssetIds: ['n-1'] }],
  }))
  const secondUpdate = captureUpdate(replica, () => second.patchNodeData('shared-prompt', {
    mentions: [{ folderId: 'natasya', name: 'Natasya', selectedAssetIds: ['na-1'] }],
  }))

  Y.applyUpdate(primary, secondUpdate, 'remote-sync')
  Y.applyUpdate(replica, firstUpdate, 'remote-sync')

  for (const doc of [primary, replica]) {
    const mentions = findNode(readCanvasProjection(doc), 'shared-prompt').data.mentions as Array<{ folderId: string }>
    assert.deepEqual(new Set(mentions.map((mention) => mention.folderId)), new Set(['nathan', 'natasya']))
  }

  second.destroy()
  first.destroy()
})

test('undo manager tracks only local binding origin', () => {
  const doc = createCanvasDocument()
  const binding = createReactFlowBinding(doc)

  binding.createNode({
    id: 'local-node',
    type: 'prompt',
    position: { x: 1, y: 2 },
    data: { sceneId: 'scene-1', label: 'Local' },
  })

  const remoteReplica = new Y.Doc()
  Y.applyUpdate(remoteReplica, Y.encodeStateAsUpdate(doc))
  const remoteUpdate = captureUpdate(remoteReplica, () => {
    upsertNode(remoteReplica, {
      id: 'remote-node',
      type: 'prompt',
      position: { x: 3, y: 4 },
      data: { sceneId: 'scene-1', label: 'Remote' },
    })
  })

  Y.applyUpdate(doc, remoteUpdate, 'remote-sync')

  binding.undo()
  let projection = readCanvasProjection(doc)
  assert.equal(projection.nodes.some((node) => node.id === 'local-node'), false)
  assert.equal(projection.nodes.some((node) => node.id === 'remote-node'), true)

  binding.redo()
  projection = readCanvasProjection(doc)
  assert.equal(projection.nodes.some((node) => node.id === 'local-node'), true)
  assert.equal(projection.nodes.some((node) => node.id === 'remote-node'), true)

  binding.destroy()
})

test('resolveRealtimeWebsocketUrl prefers configured public realtime URL', () => {
  const previous = process.env.NEXT_PUBLIC_REALTIME_URL
  process.env.NEXT_PUBLIC_REALTIME_URL = 'ws://127.0.0.1:3008'

  try {
    assert.equal(
      resolveRealtimeWebsocketUrl(new URL('http://localhost:3101/spite')),
      'ws://127.0.0.1:3008/',
    )
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_REALTIME_URL
    else process.env.NEXT_PUBLIC_REALTIME_URL = previous
  }
})

test('resolveRealtimeWebsocketUrl falls back to same-origin websocket path', () => {
  const previous = process.env.NEXT_PUBLIC_REALTIME_URL
  delete process.env.NEXT_PUBLIC_REALTIME_URL

  try {
    assert.equal(
      resolveRealtimeWebsocketUrl(new URL('http://localhost:3101/spite')),
      'ws://localhost:3101/spite/ws',
    )
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_REALTIME_URL
    else process.env.NEXT_PUBLIC_REALTIME_URL = previous
  }
})

test('realtime room emits one awareness update per awareness event', () => {
  const awarenessProjectId = '550e8400-e29b-41d4-a716-446655440001'
  const createdProviders: FakeProvider[] = []
  const room = getOrCreateRealtimeCanvasRoom(awarenessProjectId, {
    websocketUrl: 'ws://127.0.0.1:3000/spite/ws',
    fetchFn: async () => new Response(JSON.stringify({ token: 'unused' }), { status: 200 }),
    createProvider: (configuration) => {
      const provider = new FakeProvider(configuration as any)
      createdProviders.push(provider)
      return provider as any
    },
  })

  let emissions = 0
  const unsubscribe = room.subscribe(() => {
    emissions += 1
  })

  createdProviders[0].awareness.setState(42, { name: 'Alice' })
  createdProviders[0].awareness.emit('change')
  assert.equal(emissions, 1)
  assert.deepEqual(room.getSnapshot().peers, [{ clientId: 42, name: 'Alice' }])

  createdProviders[0].awareness.emit('update')
  assert.equal(emissions, 2)
  assert.deepEqual(room.getSnapshot().peers, [{ clientId: 42, name: 'Alice' }])

  unsubscribe()
  room.retain()
  releaseRealtimeCanvasRoom(awarenessProjectId)
})

test('realtime room caches one doc/provider per project, refreshes tokens through the provider callback, and parses durable status messages', async () => {
  const tokenProjectId = '550e8400-e29b-41d4-a716-446655440002'
  const fetchCalls: Array<{ input: string; init: RequestInit | undefined }> = []
  const createdProviders: FakeProvider[] = []

  const roomA = getOrCreateRealtimeCanvasRoom(tokenProjectId, {
    websocketUrl: 'ws://127.0.0.1:3000/spite/ws',
    fetchFn: async (input, init) => {
      fetchCalls.push({ input: String(input), init })
      return new Response(JSON.stringify({ token: 'realtime-token', expiresAt: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    createProvider: (configuration) => {
      const provider = new FakeProvider(configuration as any)
      createdProviders.push(provider)
      return provider as any
    },
  })
  const roomB = getOrCreateRealtimeCanvasRoom(tokenProjectId, {
    websocketUrl: 'ws://127.0.0.1:3000/spite/ws',
    fetchFn: async () => {
      throw new Error('cached room should reuse the original fetcher')
    },
    createProvider: () => {
      throw new Error('cached room should reuse the original provider')
    },
  })

  assert.equal(roomA, roomB)
  assert.equal(createdProviders.length, 1)

  const tokenOne = await createdProviders[0].requestToken()
  const tokenTwo = await createdProviders[0].requestToken()
  assert.equal(tokenOne, 'realtime-token')
  assert.equal(tokenTwo, 'realtime-token')
  assert.deepEqual(
    fetchCalls.map((call) => call.input),
    ['/api/auth/realtime-token', '/api/auth/realtime-token'],
  )
  assert.deepEqual(
    fetchCalls.map((call) => call.init?.method),
    ['POST', 'POST'],
  )

  createdProviders[0].emitStateless(
    JSON.stringify({ type: 'STATUS', projectId: tokenProjectId, status: 'DEGRADED' }),
  )
  assert.equal(roomA.getSnapshot().persistenceStatus, 'DEGRADED')

  createdProviders[0].emitStateless(
    JSON.stringify({ type: 'ACK', projectId: tokenProjectId, status: 'PERSISTED', seq: 7 }),
  )
  assert.equal(roomA.getSnapshot().persistenceStatus, 'PERSISTED')

  roomA.retain()
  roomB.retain()
  releaseRealtimeCanvasRoom(tokenProjectId)
  assert.equal(createdProviders[0].destroyed, false)
  releaseRealtimeCanvasRoom(tokenProjectId)
  assert.equal(createdProviders[0].destroyed, true)
}
)