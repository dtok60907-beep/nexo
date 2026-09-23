import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import * as Y from 'yjs'

import {
  readCanvasProjection,
  type CanvasEdgeProjection,
  type CanvasNodeProjection,
  type CanvasProjection,
} from './document'

export const LOCAL_REACT_FLOW_ORIGIN = Object.freeze({ source: 'spite-react-flow-binding' })

type JsonRecord = Record<string, unknown>
type CanvasScene = CanvasProjection['scenes'][number]
type Position = CanvasNodeProjection['position']

type NodeInput = Partial<CanvasNodeProjection> & {
  id: string
  position?: Position
  data?: JsonRecord
  [key: string]: unknown
}

type EdgeInput = Partial<CanvasEdgeProjection> & {
  id: string
  source: string
  target: string
  data?: JsonRecord
  [key: string]: unknown
}

type NodePatch = Partial<Omit<NodeInput, 'id'>>
type NodeDataUpdater = (currentData: JsonRecord) => JsonRecord

type RawBindingMutations = {
  createNode: (node: NodeInput) => void
  patchNode: (nodeId: string, patch: NodePatch) => void
  patchNodeData: (nodeId: string, patch: JsonRecord) => void
  deleteNode: (nodeId: string) => void
  createEdge: (edge: EdgeInput) => void
  deleteEdge: (edgeId: string) => void
  createScene: (name?: string) => string
  deleteScene: (sceneId: string) => void
  switchScene: (sceneId: string) => void
  setProjectName: (name: string) => void
}

export type RealtimeCanvasBindingSnapshot = {
  nodes: CanvasNodeProjection[]
  edges: CanvasEdgeProjection[]
  allNodes: CanvasNodeProjection[]
  allEdges: CanvasEdgeProjection[]
  scenes: CanvasScene[]
  activeSceneId: string
  projectName: string
}

export type RealtimeCanvasBinding = RawBindingMutations & {
  getSnapshot: () => RealtimeCanvasBindingSnapshot
  subscribe: (listener: () => void) => () => void
  applyNodeChanges: (changes: NodeChange[]) => void
  applyEdgeChanges: (changes: EdgeChange[]) => void
  updateNodeData: (nodeId: string, updater: NodeDataUpdater) => void
  replaceShot: (nodeId: string, shotId: string) => void
  createNextShot: (nodeId: string) => string | null
  duplicateNodes: (nodeIds: string[]) => string[]
  connect: (connection: Connection) => string | null
  batch: (callback: (mutations: RawBindingMutations) => void) => void
  undo: () => void
  redo: () => void
  destroy: () => void
}

export type ReactFlowBindingOptions = {
  createId?: () => string
  createSceneId?: () => string
  duplicateOffset?: Position
}

const NODE_EPHEMERAL_KEYS = new Set(['selected', 'dragging', 'measured'])
const EDGE_EPHEMERAL_KEYS = new Set(['selected'])
const DEFAULT_DUPLICATE_OFFSET = { x: 40, y: 40 }

export function createReactFlowBinding(
  doc: Y.Doc,
  options: ReactFlowBindingOptions = {},
): RealtimeCanvasBinding {
  const listeners = new Set<() => void>()
  const duplicateOffset = options.duplicateOffset ?? DEFAULT_DUPLICATE_OFFSET
  let projection = readCanvasProjection(doc)
  let activeSceneId = projection.scenes[0].id
  let snapshot = deriveSnapshot(projection, activeSceneId)

  const undoManager = new Y.UndoManager([doc.getMap('nodes'), doc.getMap('edges'), doc.getMap('meta')], {
    trackedOrigins: new Set([LOCAL_REACT_FLOW_ORIGIN]),
  })

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

  doc.on('update', handleUpdate)

  const rawMutations: RawBindingMutations = {
    createNode(node) {
      upsertNodeRecord(doc, normalizeNode(node, activeSceneId))
    },

    patchNode(nodeId, patch) {
      if (!nodeId) return
      patchNodeRecord(doc, nodeId, patch)
    },

    patchNodeData(nodeId, patch) {
      if (!nodeId) return
      patchNodeDataRecord(doc, nodeId, patch)
    },

    deleteNode(nodeId) {
      if (!nodeId) return
      deleteNodeRecord(doc, nodeId)
    },

    createEdge(edge) {
      upsertEdgeRecord(doc, normalizeEdge(edge))
    },

    deleteEdge(edgeId) {
      if (!edgeId) return
      deleteEdgeRecord(doc, edgeId)
    },

    createScene(name) {
      const nextId = options.createSceneId?.() ?? createSceneId()
      const scenes = readCanvasProjection(doc).scenes
      activeSceneId = nextId
      setScenesRecord(doc, [...scenes, { id: nextId, name: name ?? nextSceneName(scenes) }])
      return nextId
    },

    deleteScene(sceneId) {
      if (!sceneId) return
      deleteSceneRecord(doc, sceneId)
    },

    switchScene(sceneId) {
      if (!readCanvasProjection(doc).scenes.some((scene) => scene.id === sceneId)) return
      activeSceneId = sceneId
    },

    setProjectName(name) {
      setProjectNameRecord(doc, name)
    },
  }

  const binding: RealtimeCanvasBinding = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    applyNodeChanges(changes) {
      if (changes.length === 0) return
      const currentNodes = snapshot.nodes as Node[]
      const nextNodes = applyNodeChanges(changes, currentNodes) as Node[]
      const nextNodesById = new Map(nextNodes.map((node) => [node.id, node]))

      runLocalTransaction(doc, () => {
        for (const change of changes) {
          switch (change.type) {
            case 'add': {
              const nextNode = nextNodesById.get(change.item.id)
              if (nextNode) {
                upsertNodeRecord(doc, normalizeNode(nextNode as NodeInput, activeSceneId))
              }
              break
            }
            case 'remove':
              deleteNodeRecord(doc, change.id)
              break
            case 'replace': {
              const nextNode = nextNodesById.get(change.id)
              if (nextNode) {
                upsertNodeRecord(doc, normalizeNode(nextNode as NodeInput, activeSceneId))
              }
              break
            }
            case 'position':
              patchNodeRecord(doc, change.id, { position: change.position })
              break
            case 'dimensions': {
              const nextNode = nextNodesById.get(change.id) as (Node & { width?: number; height?: number }) | undefined
              if (nextNode) {
                const patch: NodePatch = {}
                if (typeof nextNode.width === 'number') patch.width = nextNode.width
                if (typeof nextNode.height === 'number') patch.height = nextNode.height
                if (Object.keys(patch).length > 0) {
                  patchNodeRecord(doc, change.id, patch)
                }
              }
              break
            }
            case 'select':
              break
            default:
              break
          }
        }
      })
    },

    applyEdgeChanges(changes) {
      if (changes.length === 0) return
      const currentEdges = snapshot.edges as Edge[]
      const nextEdges = applyEdgeChanges(changes, currentEdges) as Edge[]
      const nextEdgesById = new Map(nextEdges.map((edge) => [edge.id, edge]))

      runLocalTransaction(doc, () => {
        for (const change of changes) {
          switch (change.type) {
            case 'add': {
              const nextEdge = nextEdgesById.get(change.item.id)
              if (nextEdge) {
                upsertEdgeRecord(doc, normalizeEdge(nextEdge as EdgeInput))
              }
              break
            }
            case 'remove':
              deleteEdgeRecord(doc, change.id)
              break
            case 'replace': {
              const nextEdge = nextEdgesById.get(change.id)
              if (nextEdge) {
                upsertEdgeRecord(doc, normalizeEdge(nextEdge as EdgeInput))
              }
              break
            }
            case 'select':
              break
            default:
              break
          }
        }
      })
    },

    createNode(node) {
      runLocalTransaction(doc, () => {
        rawMutations.createNode(node)
      })
    },

    patchNode(nodeId, patch) {
      runLocalTransaction(doc, () => {
        rawMutations.patchNode(nodeId, patch)
      })
    },

    patchNodeData(nodeId, patch) {
      runLocalTransaction(doc, () => {
        rawMutations.patchNodeData(nodeId, patch)
      })
    },

    updateNodeData(nodeId, updater) {
      if (!nodeId) return
      runLocalTransaction(doc, () => {
        updateNodeDataRecord(doc, nodeId, updater)
      })
    },

    replaceShot(nodeId, shotId) {
      if (!nodeId || !shotId) return
      runLocalTransaction(doc, () => {
        replaceShotRecord(doc, nodeId, shotId)
      })
    },

    createNextShot(nodeId) {
      if (!nodeId) return null
      let shotId: string | null = null
      runLocalTransaction(doc, () => {
        shotId = createNextShotRecord(doc, nodeId)
      })
      return shotId
    },

    deleteNode(nodeId) {
      runLocalTransaction(doc, () => {
        rawMutations.deleteNode(nodeId)
      })
    },

    createEdge(edge) {
      runLocalTransaction(doc, () => {
        rawMutations.createEdge(edge)
      })
    },

    deleteEdge(edgeId) {
      runLocalTransaction(doc, () => {
        rawMutations.deleteEdge(edgeId)
      })
    },

    createScene(name) {
      let nextId = ''
      runLocalTransaction(doc, () => {
        nextId = rawMutations.createScene(name)
      })
      return nextId
    },

    deleteScene(sceneId) {
      runLocalTransaction(doc, () => {
        rawMutations.deleteScene(sceneId)
      })
    },

    switchScene(sceneId) {
      const previousSceneId = activeSceneId
      rawMutations.switchScene(sceneId)
      if (activeSceneId !== previousSceneId) refreshSnapshot()
    },

    setProjectName(name) {
      runLocalTransaction(doc, () => {
        rawMutations.setProjectName(name)
      })
    },

    duplicateNodes(nodeIds) {
      const projection = readCanvasProjection(doc)
      const selectedIds = new Set(nodeIds)
      const createdIds: string[] = []
      const idMap = new Map<string, string>()
      const nodesToDuplicate = projection.nodes.filter((node) => selectedIds.has(node.id))
      const edgesToDuplicate = projection.edges.filter(
        (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
      )

      runLocalTransaction(doc, () => {
        for (const node of nodesToDuplicate) {
          const nextId = options.createId?.() ?? createItemId('node')
          idMap.set(node.id, nextId)
          createdIds.push(nextId)
          upsertNodeRecord(doc, {
            ...normalizeNode(node as NodeInput, activeSceneId),
            id: nextId,
            position: {
              x: node.position.x + duplicateOffset.x,
              y: node.position.y + duplicateOffset.y,
            },
          })
        }

        for (const edge of edgesToDuplicate) {
          const source = idMap.get(edge.source)
          const target = idMap.get(edge.target)
          if (!source || !target) continue
          upsertEdgeRecord(doc, {
            ...normalizeEdge(edge),
            id: options.createId?.() ?? createItemId('edge'),
            source,
            target,
          })
        }
      })

      return createdIds
    },

    connect(connection) {
      if (!connection.source || !connection.target) {
        return null
      }

      const edgeId = options.createId?.() ?? createItemId('edge')
      runLocalTransaction(doc, () => {
        upsertEdgeRecord(doc, normalizeEdge({
          id: edgeId,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          animated: true,
          data: {},
        }))
      })
      return edgeId
    },

    batch(callback) {
      const previousSceneId = activeSceneId
      runLocalTransaction(doc, () => callback(rawMutations))
      if (activeSceneId !== previousSceneId && snapshot.activeSceneId !== activeSceneId) {
        refreshSnapshot()
      }
    },

    undo() {
      undoManager.undo()
    },

    redo() {
      undoManager.redo()
    },

    destroy() {
      listeners.clear()
      doc.off('update', handleUpdate)
      undoManager.destroy()
    },
  }

  return binding
}

function deriveSnapshot(
  projection: CanvasProjection,
  activeSceneId: string,
): RealtimeCanvasBindingSnapshot {
  const allNodes = projection.nodes.map((node) => ({ ...node, data: { ...ensureRecord(node.data) } }))
  const allEdges = projection.edges.map((edge) => ({ ...edge, data: { ...ensureRecord(edge.data) } }))
  const nodes = allNodes.filter((node) => readNodeSceneId(node) === activeSceneId)
  const visibleNodeIds = new Set(nodes.map((node) => node.id))
  const edges = allEdges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  )

  return {
    nodes,
    edges,
    allNodes,
    allEdges,
    scenes: projection.scenes.map((scene) => ({ ...scene })),
    activeSceneId,
    projectName: projection.projectName ?? 'Untitled Project',  }
}

function runLocalTransaction(doc: Y.Doc, callback: () => void): void {
  doc.transact(callback, LOCAL_REACT_FLOW_ORIGIN)
}

function upsertNodeRecord(doc: Y.Doc, node: NodeInput): void {
  doc.getMap<Y.Map<unknown>>('nodes').set(node.id, buildNodeMap(node))
}

function patchNodeRecord(doc: Y.Doc, nodeId: string, patch: NodePatch): void {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  const existing = nodes.get(nodeId)
  if (!(existing instanceof Y.Map)) return

  if (patch.type !== undefined) {
    setOrDelete(existing, 'type', patch.type)
  }

  if (isPosition(patch.position)) {
    if (Number.isFinite(Number(patch.position.x))) {
      setOrDelete(existing, 'positionX', Number(patch.position.x))
    }
    if (Number.isFinite(Number(patch.position.y))) {
      setOrDelete(existing, 'positionY', Number(patch.position.y))
    }
  }

  if (patch.data !== undefined) {
    const nextData = ensureRecord(patch.data)
    const data = ensureDataMap(existing)
    for (const key of Array.from(data.keys())) {
      if (!(key in nextData)) data.delete(key)
    }
    for (const [key, value] of Object.entries(nextData)) {
      setDataValue(data, key, value)
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    if (
      key === 'type' ||
      key === 'position' ||
      key === 'data' ||
      NODE_EPHEMERAL_KEYS.has(key)
    ) {
      continue
    }
    setOrDelete(existing, key, value)
  }
}

function patchNodeDataRecord(doc: Y.Doc, nodeId: string, patch: JsonRecord): void {
  updateNodeDataRecord(doc, nodeId, (currentData) => {
    const nextData = { ...currentData }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete nextData[key]
      else nextData[key] = value
    }
    return nextData
  })
}

function updateNodeDataRecord(doc: Y.Doc, nodeId: string, updater: NodeDataUpdater): void {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  const existing = nodes.get(nodeId)
  if (!(existing instanceof Y.Map)) return

  const currentData = readDataRecord(existing)
  const nextData = ensureRecord(updater({ ...currentData }))
  const data = ensureDataMap(existing)
  for (const key of Object.keys(currentData)) {
    if (!(key in nextData) || nextData[key] === undefined) data.delete(key)
  }
  for (const [key, value] of Object.entries(nextData)) {
    if (value !== undefined) setDataValue(data, key, value)
  }
}

function replaceShotRecord(doc: Y.Doc, nodeId: string, shotId: string): void {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  const self = nodes.get(nodeId)
  if (!(self instanceof Y.Map)) return

  const selfData = readDataRecord(self)
  const sceneId = typeof selfData.sceneId === 'string' ? selfData.sceneId : undefined

  for (const [currentNodeId, node] of nodes.entries()) {
    if (!(node instanceof Y.Map)) continue
    const data = readDataRecord(node)
    const sameScene = !sceneId || data.sceneId === sceneId
    const currentShotId = (data.shotId || data.selectedShotId) as string | undefined
    if (currentNodeId === nodeId) {
      patchNodeDataRecord(doc, currentNodeId, {
        shotId,
        selectedShotId: undefined,
      })
      continue
    }
    if (!sameScene || currentShotId !== shotId) continue
    patchNodeDataRecord(doc, currentNodeId, {
      shotId: undefined,
      selectedShotId: undefined,
    })
  }
}

function createNextShotRecord(doc: Y.Doc, nodeId: string): string | null {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  const self = nodes.get(nodeId)
  if (!(self instanceof Y.Map)) return null

  const selfData = readDataRecord(self)
  const sceneId = typeof selfData.sceneId === 'string' ? selfData.sceneId : undefined
  let maxNum = 0

  for (const node of nodes.values()) {
    if (!(node instanceof Y.Map)) continue
    const data = readDataRecord(node)
    if (sceneId && data.sceneId !== sceneId) continue
    const match = String(data.shotId || data.selectedShotId || '').match(/^shot-(\d+)$/)
    if (match) {
      maxNum = Math.max(maxNum, Number.parseInt(match[1], 10))
    }
  }

  const shotId = `shot-${maxNum + 1}`
  patchNodeDataRecord(doc, nodeId, {
    shotId,
    selectedShotId: undefined,
  })
  return shotId
}

function deleteNodeRecord(doc: Y.Doc, nodeId: string): void {
  doc.getMap<Y.Map<unknown>>('nodes').delete(nodeId)

  const edges = doc.getMap<Y.Map<unknown>>('edges')
  for (const [edgeId, edge] of edges.entries()) {
    if (!(edge instanceof Y.Map)) continue
    if (edge.get('source') === nodeId || edge.get('target') === nodeId) {
      edges.delete(edgeId)
    }
  }
}

function upsertEdgeRecord(doc: Y.Doc, edge: EdgeInput): void {
  doc.getMap<Y.Map<unknown>>('edges').set(edge.id, buildEdgeMap(edge))
}

function deleteEdgeRecord(doc: Y.Doc, edgeId: string): void {
  doc.getMap<Y.Map<unknown>>('edges').delete(edgeId)
}

function setScenesRecord(doc: Y.Doc, scenes: CanvasScene[]): void {
  const meta = doc.getMap('meta')
  meta.set('scenes', scenes.map((scene) => ({ id: scene.id, name: scene.name })))
}

function setProjectNameRecord(doc: Y.Doc, name: string): void {
  const projectName = name.trim() || 'Untitled Project'
  if ((readCanvasProjection(doc).projectName ?? 'Untitled Project') !== projectName) {
    doc.getMap('meta').set('projectName', projectName)
  }
}

function deleteSceneRecord(doc: Y.Doc, sceneId: string): void {
  const projection = readCanvasProjection(doc)
  if (!projection.scenes.some((scene) => scene.id === sceneId)) {
    return
  }

  const nextScenes = projection.scenes.filter((scene) => scene.id !== sceneId)
  const safeScenes = nextScenes.length > 0 ? nextScenes : [{ id: 'scene-1', name: 'Scene 1' }]
  const nextActiveSceneId =
    projection.activeSceneId === sceneId ? safeScenes[Math.max(0, projection.scenes.findIndex((scene) => scene.id === sceneId) - 1)]?.id ?? safeScenes[0].id : projection.activeSceneId

  setScenesRecord(doc, safeScenes)
  doc.getMap('meta').set('activeSceneId', nextActiveSceneId)

  const doomedNodeIds = projection.nodes
    .filter((node) => readNodeSceneId(node) === sceneId)
    .map((node) => node.id)

  for (const nodeId of doomedNodeIds) {
    deleteNodeRecord(doc, nodeId)
  }
}

function readNodeSceneId(node: { data?: unknown }): string | undefined {
  const data = ensureRecord(node.data)
  return typeof data.sceneId === 'string' && data.sceneId ? data.sceneId : undefined
}

function normalizeNode(node: NodeInput, defaultSceneId: string): NodeInput {
  const data = ensureRecord(node.data)
  const position = isPosition(node.position) ? node.position : undefined

  return {
    ...sanitizeUnknownFields(node, NODE_EPHEMERAL_KEYS),
    id: node.id,
    type: typeof node.type === 'string' ? node.type : undefined,
    position: {
      x: asNumber(position?.x),
      y: asNumber(position?.y),
    },
    data: {
      ...data,
      sceneId: typeof data.sceneId === 'string' && data.sceneId ? data.sceneId : defaultSceneId,
    },
  }
}

function normalizeEdge(edge: EdgeInput): EdgeInput {
  return {
    ...sanitizeUnknownFields(edge, EDGE_EPHEMERAL_KEYS),
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    animated: edge.animated ?? undefined,
    data: ensureRecord(edge.data),
  }
}

function sanitizeUnknownFields(
  input: Record<string, unknown>,
  ephemeralKeys: Set<string>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (ephemeralKeys.has(key) || key === 'id' || key === 'type' || key === 'position' || key === 'data' || key === 'source' || key === 'target' || key === 'sourceHandle' || key === 'targetHandle' || key === 'animated') {
      continue
    }
    output[key] = value
  }
  return output
}

function buildNodeMap(node: NodeInput): Y.Map<unknown> {
  const normalized = normalizeNode(node, 'scene-1')
  const map = new Y.Map<unknown>()
  map.set('id', normalized.id)
  if (normalized.type !== undefined) {
    map.set('type', normalized.type)
  }
  map.set('positionX', asNumber(normalized.position?.x))
  map.set('positionY', asNumber(normalized.position?.y))
  map.set('data', createDataMap(normalized.data))

  for (const [key, value] of Object.entries(normalized)) {
    if (key === 'id' || key === 'type' || key === 'position' || key === 'data') {
      continue
    }
    map.set(key, value)
  }

  return map
}

function buildEdgeMap(edge: EdgeInput): Y.Map<unknown> {
  const normalized = normalizeEdge(edge)
  const map = new Y.Map<unknown>()
  map.set('id', normalized.id)
  map.set('source', normalized.source)
  map.set('target', normalized.target)
  map.set('data', createDataMap(normalized.data))

  if (normalized.sourceHandle !== undefined) {
    map.set('sourceHandle', normalized.sourceHandle)
  }
  if (normalized.targetHandle !== undefined) {
    map.set('targetHandle', normalized.targetHandle)
  }
  if (normalized.animated !== undefined) {
    map.set('animated', normalized.animated)
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (
      key === 'id' ||
      key === 'source' ||
      key === 'target' ||
      key === 'sourceHandle' ||
      key === 'targetHandle' ||
      key === 'animated' ||
      key === 'data'
    ) {
      continue
    }
    map.set(key, value)
  }

  return map
}

function setOrDelete(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key)
    return
  }
  if (!Object.is(map.get(key), value)) {
    map.set(key, value)
  }
}

function ensureDataMap(node: Y.Map<unknown>): Y.Map<unknown> {
  const current = node.get('data')
  if (current instanceof Y.Map) return current

  const data = createDataMap(current)
  node.set('data', data)
  return data
}

function readDataRecord(node: Y.Map<unknown>): JsonRecord {
  const data = node.get('data')
  if (data instanceof Y.Map) {
    return Object.fromEntries(Array.from(data.entries()).map(([key, value]) => [key, cloneYValue(value)]))
  }
  return ensureRecord(data)
}

function createDataMap(value: unknown): Y.Map<unknown> {
  const data = new Y.Map<unknown>()
  for (const [key, item] of Object.entries(ensureRecord(value))) {
    data.set(key, toYDataValue(key, item))
  }
  return data
}

function cloneYValue(value: unknown): unknown {
  if (value instanceof Y.Text) return value.toString()
  if (value instanceof Y.Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, item]) => [key, cloneYValue(item)]))
  }
  if (value instanceof Y.Array) return value.toArray().map(cloneYValue)
  return value
}

function setDataValue(data: Y.Map<unknown>, key: string, value: unknown): void {
  if (key === 'text' && typeof value === 'string') {
    const current = data.get(key)
    const text = current instanceof Y.Text ? current : new Y.Text(typeof current === 'string' ? current : '')
    if (!(current instanceof Y.Text)) data.set(key, text)
    replaceYText(text, value)
    return
  }
  if (key === 'mentions' && Array.isArray(value)) {
    const current = data.get(key)
    const mentions = current instanceof Y.Array ? current : new Y.Array<unknown>()
    if (!(current instanceof Y.Array)) {
      const prior = Array.isArray(current) ? current : []
      if (prior.length) mentions.insert(0, prior)
      data.set(key, mentions)
    }
    mentions.delete(0, mentions.length)
    if (value.length) mentions.insert(0, value)
    return
  }
  setOrDelete(data, key, value)
}

function toYDataValue(key: string, value: unknown): unknown {
  if (key === 'text' && typeof value === 'string') return new Y.Text(value)
  if (key === 'mentions' && Array.isArray(value)) {
    const mentions = new Y.Array<unknown>()
    if (value.length) mentions.insert(0, value)
    return mentions
  }
  return value
}

function replaceYText(text: Y.Text, next: string): void {
  const current = text.toString()
  if (current === next) return
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start += 1
  let end = 0
  while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end += 1
  const deleteCount = current.length - start - end
  if (deleteCount > 0) text.delete(start, deleteCount)
  const insert = next.slice(start, next.length - end)
  if (insert) text.insert(start, insert)
}

function ensureRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return { ...(value as JsonRecord) }
}

function isPosition(value: unknown): value is Position {
  return !!value && typeof value === 'object' && 'x' in value && 'y' in value
}

function asNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function createItemId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createSceneId(): string {
  return createItemId('scene')
}

function nextSceneName(scenes: CanvasScene[]): string {
  const nextNumber = scenes.reduce((max, scene) => {
    const match = scene.name.match(/^Scene (\d+)$/)
    if (!match) return max
    return Math.max(max, Number.parseInt(match[1], 10))
  }, 0)
  return `Scene ${nextNumber + 1}`
}
