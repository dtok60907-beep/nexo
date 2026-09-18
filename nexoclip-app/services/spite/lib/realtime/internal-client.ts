import { randomUUID } from 'node:crypto'

import * as Y from 'yjs'

import {
  importLegacyCanvas,
  readCanvasProjection,
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
  patchNodeData(input: PatchNodeDataInput): Promise<void>
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
      await request({
        userId: input.userId,
        projectId: input.projectId,
        action: 'patch-node-data',
        body: {
          nodeId: input.nodeId,
          set: input.set ?? {},
          unset: input.unset ?? [],
        },
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
      origin,
    })
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
    origin,
  }: {
    nodeId: string
    set: Record<string, unknown>
    unset: string[]
    origin: unknown
  },
): void {
  if (!nodeId) return

  doc.transact(() => {
    const node = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)
    if (!(node instanceof Y.Map)) {
      return
    }

    const data = ensureDataMap(node)
    for (const [key, value] of Object.entries(set)) {
      setDataValue(data, key, value)
    }
    for (const key of unset) {
      data.delete(key)
    }
  }, origin)
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

function setDataValue(data: Y.Map<unknown>, key: string, value: unknown): void {
  if (key !== 'text' || typeof value !== 'string') {
    data.set(key, value)
    return
  }
  const current = data.get(key)
  const text = current instanceof Y.Text ? current : new Y.Text(typeof current === 'string' ? current : '')
  if (!(current instanceof Y.Text)) data.set(key, text)
  const existing = text.toString()
  if (existing !== value) {
    text.delete(0, existing.length)
    if (value) text.insert(0, value)
  }
}

function ensureDataMap(node: Y.Map<unknown>): Y.Map<unknown> {
  const current = node.get('data')
  if (current instanceof Y.Map) return current

  const data = new Y.Map<unknown>()
  if (isRecord(current)) {
    for (const [key, value] of Object.entries(current)) data.set(key, value)
  }
  node.set('data', data)
  return data
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
