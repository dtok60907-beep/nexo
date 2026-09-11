import { randomUUID } from 'node:crypto'

import * as Y from 'yjs'

import {
  importLegacyCanvas,
  readCanvasProjection,
  upsertNode,
  type CanvasProjection,
} from '@/lib/realtime/document'
import {
  createCanvasAuthorizationActionDigest,
  signCanvasAuthorization,
} from '@/realtime/internal-auth'

type InternalClientEnv = Partial<Pick<NodeJS.ProcessEnv,
  'CANVAS_AUTH_URL'
  | 'CANVAS_AUTH_HMAC_SECRET'
  | 'CANVAS_AUTH_SECRET'>>

export class InternalRealtimeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'InternalRealtimeRequestError'
  }
}

export type ExportDocumentInput = {
  userId: string
  projectId: string
}

export type ExportDocumentResult = {
  projection: CanvasProjection
  durableSeq: number
  projectedSeq: number
}

export type PatchNodeDataInput = {
  userId: string
  projectId: string
  nodeId: string
  set?: Record<string, unknown>
  unset?: string[]
  /** Apply only if these current node-data values still match. */
  expected?: Record<string, unknown>
}

export type CreateNodeInput = {
  userId: string
  projectId: string
  node: CanvasProjection['nodes'][number]
}

export type ReplaceDocumentInput = {
  userId: string
  projectId: string
  projection: CanvasProjection
}

type InternalRequestInput = {
  userId: string
  projectId: string
  action: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

type InternalRequestFactoryOptions = {
  fetchFn?: typeof fetch
  env?: InternalClientEnv
  now?: () => number
  createNonce?: () => string
  signAuthorization?: typeof signCanvasAuthorization
}

export type InternalRealtimeClient = {
  exportDocument(input: ExportDocumentInput): Promise<ExportDocumentResult>
  patchNodeData(input: PatchNodeDataInput): Promise<{ applied: boolean }>
  createNode(input: CreateNodeInput): Promise<void>
  replaceDocument(input: ReplaceDocumentInput): Promise<void>
}

export function createInternalRealtimeClient(options: InternalRequestFactoryOptions = {}): InternalRealtimeClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const env = (options.env ?? process.env) as InternalClientEnv
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const createNonce = options.createNonce ?? randomUUID
  const signAuthorization = options.signAuthorization ?? signCanvasAuthorization

  async function request<T>(input: InternalRequestInput): Promise<T> {
    const url = resolveDocumentUrl(env)
    const secret = resolveAuthorizationSecret(env)
    const actionBody = {
      action: input.action,
      ...(input.body ?? {}),
    }
    const payload = {
      userId: input.userId,
      projectId: input.projectId,
      timestamp: now(),
      nonce: createNonce(),
      actionDigest: createCanvasAuthorizationActionDigest(actionBody),
    }

    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.headers ?? {}),
      },
      body: JSON.stringify({
        ...payload,
        signature: signAuthorization(payload, secret),
        ...actionBody,
      }),
    })

    if (!response.ok) {
      let responseMessage = `Realtime internal request failed with ${response.status}`
      try {
        const body = await response.json()
        if (typeof body?.error === 'string' && body.error) {
          responseMessage = body.error
        }
      } catch {}
      throw new InternalRealtimeRequestError(
        response.status,
        formatInternalRequestErrorMessage(response.status, responseMessage),
      )
    }

    return response.json() as Promise<T>
  }

  return {
    async exportDocument(input) {
      return request<ExportDocumentResult>({
        userId: input.userId,
        projectId: input.projectId,
        action: 'export-document',
      })
    },
    async patchNodeData(input) {
      return request<{ applied: boolean }>({
        userId: input.userId,
        projectId: input.projectId,
        action: 'patch-node-data',
        body: {
          nodeId: input.nodeId,
          set: input.set ?? {},
          unset: input.unset ?? [],
          expected: input.expected ?? {},
        },
      })
    },
    async createNode(input) {
      await request({
        userId: input.userId,
        projectId: input.projectId,
        action: 'create-node',
        body: { node: input.node },
      })
    },
    async replaceDocument(input) {
      await request({
        userId: input.userId,
        projectId: input.projectId,
        action: 'replace-document',
        headers: {
          'X-Canvas-Source': 'projection',
        },
        body: {
          projection: input.projection,
          source: 'projection',
        },
      })
    },
  }
}

export function applyInternalDocumentAction(
  doc: Y.Doc,
  action: string,
  body: Record<string, unknown>,
  origin: unknown = 'internal-document-action',
): void {
  if (action === 'patch-node-data') {
    patchNodeData(doc, {
      nodeId: typeof body.nodeId === 'string' ? body.nodeId : '',
      set: isRecord(body.set) ? body.set : {},
      unset: Array.isArray(body.unset) ? body.unset.filter((value): value is string => typeof value === 'string') : [],
      expected: isRecord(body.expected) ? body.expected : {},
      origin,
    })
    return
  }

  if (action === 'create-node') {
    const node = body.node
    if (!isCanvasNode(node)) throw new Error('node is required')
    if (doc.getMap('nodes').has(node.id)) throw new Error('node already exists')
    upsertNode(doc, node)
    return
  }

  if (action === 'replace-document') {
    const projection = body.projection
    if (!isCanvasProjection(projection)) {
      throw new Error('projection is required')
    }
    importLegacyCanvas(doc, projection, origin)
    return
  }

  if (action === 'export-document') {
    return
  }

  throw new Error(`Unsupported internal document action: ${action}`)
}

export function buildInternalDocumentExport(doc: Y.Doc): { projection: CanvasProjection } {
  return {
    projection: readCanvasProjection(doc),
  }
}

export function projectionHasMediaReference(
  projection: CanvasProjection,
  {
    assetId,
    url,
  }: {
    assetId?: string | null
    url?: string | null
  },
): boolean {
  return projection.nodes.some((node) => {
    const data = isRecord(node.data) ? node.data : {}
    return (
      (assetId ? data.assetId === assetId : false)
      || (url ? data.outputUrl === url || data.thumbnail === url : false)
    )
  })
}

function patchNodeData(
  doc: Y.Doc,
  {
    nodeId,
    set,
    unset,
    expected,
    origin,
  }: {
    nodeId: string
    set: Record<string, unknown>
    unset: string[]
    expected: Record<string, unknown>
    origin: unknown
  },
): void {
  if (!nodeId) return

  doc.transact(() => {
    const node = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)
    if (!(node instanceof Y.Map)) {
      return
    }

    const currentData = coerceRecord(node.get('data'))
    if (Object.entries(expected).some(([key, value]) => currentData[key] !== value && !(value === null && currentData[key] === undefined))) return

    const nextData = {
      ...currentData,
      ...set,
    }

    for (const key of unset) {
      delete nextData[key]
    }

    node.set('data', nextData)
  }, origin)
}

function isCanvasNode(value: unknown): value is CanvasProjection['nodes'][number] {
  if (!value || typeof value !== 'object') return false
  const node = value as CanvasProjection['nodes'][number]
  return typeof node.id === 'string' && !!node.id && typeof node.type === 'string'
    && !!node.position && typeof node.position.x === 'number' && typeof node.position.y === 'number'
    && isRecord(node.data)
}

function isCanvasProjection(value: unknown): value is CanvasProjection {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CanvasProjection>
  return Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges)
    && Array.isArray(candidate.scenes)
    && typeof candidate.activeSceneId === 'string'
    && (candidate.projectName === undefined || typeof candidate.projectName === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function coerceRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

function resolveDocumentUrl(env: InternalClientEnv): string {
  const authorizeUrl = env.CANVAS_AUTH_URL?.trim()
  if (!authorizeUrl) {
    throw new Error('CANVAS_AUTH_URL is required for internal realtime mutations')
  }

  return authorizeUrl.replace(/\/internal\/authorize\/?$/, '/internal/document')
}

function formatInternalRequestErrorMessage(status: number, responseMessage: string): string {
  if (status === 400) {
    return `Realtime internal request validation failed: ${responseMessage}`
  }

  if (status === 409) {
    return `Realtime internal request conflicted with read-only state: ${responseMessage}`
  }

  if (status === 503) {
    return `Realtime internal request unavailable: ${responseMessage}`
  }

  return `Realtime internal request failed with ${status}: ${responseMessage}`
}

function resolveAuthorizationSecret(env: InternalClientEnv): string {
  const secret = env.CANVAS_AUTH_HMAC_SECRET?.trim() || env.CANVAS_AUTH_SECRET?.trim()
  if (!secret) {
    throw new Error('CANVAS_AUTH_HMAC_SECRET or CANVAS_AUTH_SECRET is required for internal realtime mutations')
  }

  return secret
}
