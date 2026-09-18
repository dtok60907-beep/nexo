import * as Y from 'yjs'

export const CURRENT_SCHEMA_VERSION = 2

type JsonRecord = Record<string, unknown>

type Position = { x: number; y: number }

type CanvasNodeInput = {
  id: string
  type?: string
  position?: Position
  data?: JsonRecord
  [key: string]: unknown
}

type CanvasEdgeInput = {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  animated?: boolean
  data?: JsonRecord
  [key: string]: unknown
}

type SceneInput = {
  id: string
  name: string
}

type LegacyCanvasInput = {
  nodes?: CanvasNodeInput[]
  edges?: CanvasEdgeInput[]
  scenes?: SceneInput[]
  activeSceneId?: string
  projectName?: string
}

export type CanvasNodeProjection = {
  id: string
  type?: string
  position: Position
  data: JsonRecord
  [key: string]: unknown
}

export type CanvasEdgeProjection = {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  animated?: boolean
  data: JsonRecord
  [key: string]: unknown
}

export type CanvasProjection = {
  nodes: CanvasNodeProjection[]
  edges: CanvasEdgeProjection[]
  scenes: SceneInput[]
  activeSceneId: string
  projectName?: string
}

const PROJECT_DOC_NAME_RE = /^project:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const NODE_EPHEMERAL_KEYS = new Set(['selected', 'dragging', 'measured'])
const EDGE_EPHEMERAL_KEYS = new Set(['selected'])
const DEFAULT_SCENES: SceneInput[] = [{ id: 'scene-1', name: 'Scene 1' }]

export function createCanvasDocument(): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    doc.getMap('nodes')
    doc.getMap('edges')
    const meta = doc.getMap('meta')
    meta.set('schemaVersion', CURRENT_SCHEMA_VERSION)
    meta.set('scenes', DEFAULT_SCENES)
    meta.set('activeSceneId', DEFAULT_SCENES[0].id)
  }, 'init-canvas-document')
  return doc
}

export function parseProjectDocumentName(name: string): string {
  const match = PROJECT_DOC_NAME_RE.exec(name)
  if (!match) {
    throw new Error(`Invalid project document name: ${name}`)
  }
  return match[1]
}

export function importLegacyCanvas(
  doc: Y.Doc,
  input: LegacyCanvasInput,
  origin: unknown = 'import-legacy-canvas',
): void {
  const nodes = Array.isArray(input.nodes) ? input.nodes : []
  const edges = Array.isArray(input.edges) ? input.edges : []
  const scenes = sanitizeScenes(input.scenes)
  const activeSceneId = resolveActiveSceneId(scenes, input.activeSceneId)

  doc.transact(() => {
    const nodeMap = doc.getMap<Y.Map<unknown>>('nodes')
    const edgeMap = doc.getMap<Y.Map<unknown>>('edges')
    const meta = doc.getMap('meta')

    nodeMap.clear()
    edgeMap.clear()

    for (const node of nodes) {
      if (!node || typeof node.id !== 'string' || !node.id) continue
      nodeMap.set(node.id, buildNodeMap(node))
    }

    for (const edge of edges) {
      if (!edge || typeof edge.id !== 'string' || !edge.id) continue
      edgeMap.set(edge.id, buildEdgeMap(edge))
    }

    meta.set('schemaVersion', CURRENT_SCHEMA_VERSION)
    meta.set('scenes', scenes)
    meta.set('activeSceneId', activeSceneId)
    if (typeof input.projectName === 'string' && input.projectName.trim()) {
      meta.set('projectName', input.projectName.trim())
    }
  }, origin)
}

export function readCanvasProjection(doc: Y.Doc): CanvasProjection {
  const nodesMap = doc.getMap<Y.Map<unknown>>('nodes')
  const edgesMap = doc.getMap<Y.Map<unknown>>('edges')
  const meta = doc.getMap('meta')

  const nodes: CanvasNodeProjection[] = Array.from(nodesMap.entries())
    .map(([id, node]) => readNodeProjection(id, node))
    .sort((a, b) => a.id.localeCompare(b.id))

  const edges: CanvasEdgeProjection[] = Array.from(edgesMap.entries())
    .map(([id, edge]) => readEdgeProjection(id, edge))
    .sort((a, b) => a.id.localeCompare(b.id))

  const scenes = sanitizeScenes(meta.get('scenes'))
  const activeSceneId = resolveActiveSceneId(scenes, meta.get('activeSceneId'))
  const projectName = meta.get('projectName')

  return {
    nodes,
    edges,
    scenes,
    activeSceneId,
    ...(typeof projectName === 'string' && projectName.trim() ? { projectName: projectName.trim() } : {}),
  }
}

export function migrateCanvasDocument(doc: Y.Doc, fromVersion: number): boolean {
  if (fromVersion >= CURRENT_SCHEMA_VERSION) return false
  doc.transact(() => {
    doc.getMap('nodes')
    doc.getMap('edges')
    const meta = doc.getMap('meta')
    const scenes = sanitizeScenes(meta.get('scenes'))

    meta.set('schemaVersion', CURRENT_SCHEMA_VERSION)
    meta.set('scenes', scenes)
    meta.set('activeSceneId', resolveActiveSceneId(scenes, meta.get('activeSceneId')))
    const projectName = meta.get('projectName')
    if (typeof projectName === 'string' && projectName.trim()) {
      meta.set('projectName', projectName.trim())
    }
  }, 'migrate-canvas-document')
  return true
}

export function upsertNode(doc: Y.Doc, node: CanvasNodeInput): void {
  if (!node || typeof node.id !== 'string' || !node.id) return
  doc.transact(() => {
    doc.getMap<Y.Map<unknown>>('nodes').set(node.id, buildNodeMap(node))
  }, 'upsert-node')
}

export function patchNode(doc: Y.Doc, nodeId: string, patch: Partial<CanvasNodeInput>): void {
  if (!nodeId) return
  doc.transact(() => {
    const nodes = doc.getMap<Y.Map<unknown>>('nodes')
    const existing = nodes.get(nodeId)
    if (!(existing instanceof Y.Map)) return

    if (patch.type !== undefined) existing.set('type', patch.type)

    if (patch.position && typeof patch.position === 'object') {
      const x = Number(patch.position.x)
      const y = Number(patch.position.y)
      if (Number.isFinite(x)) existing.set('positionX', x)
      if (Number.isFinite(y)) existing.set('positionY', y)
    }

    if (patch.data !== undefined) {
      existing.set('data', createDataMap(patch.data))
    }

    for (const [key, value] of Object.entries(patch)) {
      if (
        key === 'id' ||
        key === 'type' ||
        key === 'position' ||
        key === 'data' ||
        NODE_EPHEMERAL_KEYS.has(key)
      ) {
        continue
      }
      existing.set(key, value)
    }
  }, 'patch-node')
}

export function deleteNode(doc: Y.Doc, nodeId: string): void {
  if (!nodeId) return
  doc.transact(() => {
    doc.getMap('nodes').delete(nodeId)
  }, 'delete-node')
}

export function upsertEdge(doc: Y.Doc, edge: CanvasEdgeInput): void {
  if (!edge || typeof edge.id !== 'string' || !edge.id) return
  doc.transact(() => {
    doc.getMap<Y.Map<unknown>>('edges').set(edge.id, buildEdgeMap(edge))
  }, 'upsert-edge')
}

export function deleteEdge(doc: Y.Doc, edgeId: string): void {
  if (!edgeId) return
  doc.transact(() => {
    doc.getMap('edges').delete(edgeId)
  }, 'delete-edge')
}

export function setScenes(doc: Y.Doc, scenes: SceneInput[]): void {
  doc.transact(() => {
    const meta = doc.getMap('meta')
    const nextScenes = sanitizeScenes(scenes)
    meta.set('scenes', nextScenes)
    meta.set('activeSceneId', resolveActiveSceneId(nextScenes, meta.get('activeSceneId')))
  }, 'set-scenes')
}

export function setActiveSceneId(doc: Y.Doc, activeSceneId: string): void {
  if (!activeSceneId) return
  doc.transact(() => {
    doc.getMap('meta').set('activeSceneId', activeSceneId)
  }, 'set-active-scene-id')
}

export function setProjectName(doc: Y.Doc, projectName: string): void {
  const name = projectName.trim() || 'Untitled Project'
  doc.transact(() => {
    doc.getMap('meta').set('projectName', name)
  }, 'set-project-name')
}

function buildNodeMap(node: CanvasNodeInput): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('id', node.id)

  if (node.type !== undefined) map.set('type', node.type)

  const x = Number(node.position?.x)
  const y = Number(node.position?.y)
  map.set('positionX', Number.isFinite(x) ? x : 0)
  map.set('positionY', Number.isFinite(y) ? y : 0)

  map.set('data', createDataMap(node.data))

  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'id' ||
      key === 'type' ||
      key === 'position' ||
      key === 'data' ||
      NODE_EPHEMERAL_KEYS.has(key)
    ) {
      continue
    }
    map.set(key, value)
  }

  return map
}

function buildEdgeMap(edge: CanvasEdgeInput): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('id', edge.id)
  map.set('source', edge.source)
  map.set('target', edge.target)

  if (edge.sourceHandle !== undefined) map.set('sourceHandle', edge.sourceHandle)
  if (edge.targetHandle !== undefined) map.set('targetHandle', edge.targetHandle)
  if (edge.animated !== undefined) map.set('animated', edge.animated)
  map.set('data', createDataMap(edge.data))

  for (const [key, value] of Object.entries(edge)) {
    if (
      key === 'id' ||
      key === 'source' ||
      key === 'target' ||
      key === 'sourceHandle' ||
      key === 'targetHandle' ||
      key === 'animated' ||
      key === 'data' ||
      EDGE_EPHEMERAL_KEYS.has(key)
    ) {
      continue
    }
    map.set(key, value)
  }

  return map
}

function readNodeProjection(id: string, node: Y.Map<unknown>): CanvasNodeProjection {
  const output: CanvasNodeProjection = {
    id,
    position: {
      x: asNumber(node.get('positionX')),
      y: asNumber(node.get('positionY')),
    },
    data: ensureRecord(node.get('data')),
  }

  for (const [key, value] of node.entries()) {
    if (key === 'id' || key === 'positionX' || key === 'positionY' || key === 'data') continue
    if (NODE_EPHEMERAL_KEYS.has(key)) continue
    output[key] = value
  }

  return output
}

function readEdgeProjection(id: string, edge: Y.Map<unknown>): CanvasEdgeProjection {
  const output: CanvasEdgeProjection = {
    id,
    source: String(edge.get('source') ?? ''),
    target: String(edge.get('target') ?? ''),
    data: ensureRecord(edge.get('data')),
  }

  for (const [key, value] of edge.entries()) {
    if (key === 'id' || key === 'source' || key === 'target' || key === 'data') continue
    if (EDGE_EPHEMERAL_KEYS.has(key)) continue
    output[key] = value
  }

  return output
}

function sanitizeScenes(raw: unknown): SceneInput[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SCENES]
  const scenes = raw
    .filter((scene): scene is SceneInput => {
      return Boolean(
        scene &&
          typeof scene === 'object' &&
          typeof (scene as SceneInput).id === 'string' &&
          (scene as SceneInput).id &&
          typeof (scene as SceneInput).name === 'string' &&
          (scene as SceneInput).name,
      )
    })
    .map((scene) => ({ id: scene.id, name: scene.name }))

  return scenes.length > 0 ? scenes : [...DEFAULT_SCENES]
}

function resolveActiveSceneId(scenes: SceneInput[], candidate: unknown): string {
  if (typeof candidate === 'string' && scenes.some((scene) => scene.id === candidate)) {
    return candidate
  }
  return scenes[0]?.id || DEFAULT_SCENES[0].id
}

function asNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function ensureRecord(value: unknown): JsonRecord {
  if (value instanceof Y.Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, item]) => [key, cloneYValue(item)]))
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as JsonRecord) }
}

function createDataMap(value: unknown): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const [key, item] of Object.entries(ensureRecord(value))) {
    if (key === 'text' && typeof item === 'string') {
      map.set(key, new Y.Text(item))
    } else if (key === 'mentions' && Array.isArray(item)) {
      const mentions = new Y.Array<unknown>()
      if (item.length) mentions.insert(0, item)
      map.set(key, mentions)
    } else {
      map.set(key, item)
    }
  }
  return map
}

function cloneYValue(value: unknown): unknown {
  if (value instanceof Y.Text) return value.toString()
  if (value instanceof Y.Map) return ensureRecord(value)
  if (value instanceof Y.Array) return value.toArray().map(cloneYValue)
  return value
}
