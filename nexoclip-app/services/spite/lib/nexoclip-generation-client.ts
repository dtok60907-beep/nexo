import {
  createCanvasAuthorizationActionDigest,
  signCanvasAuthorization,
} from '../../../src/lib/realtime/internalAuth.js'

export type DurableGenerationInput = {
  kind: 'image' | 'video'
  prompt: string
  model: string
  parameters: Record<string, unknown>
  idempotencyKey: string
}

export type DurableGeneration = {
  id: string
  kind: 'image' | 'video'
  status: 'queued' | 'running' | 'processing' | 'succeeded' | 'failed'
  result?: Record<string, unknown> | null
  error?: { message?: string } | null
  outputs?: Array<{ assetId: string; download?: { url: string }; url?: string }>
}

export type NexoClipGenerationClient = {
  submit(input: { userId: string; projectId: string; nodeId: string; input: DurableGenerationInput }): Promise<DurableGeneration>
  status(input: { userId: string; projectId: string; nodeId: string; generationId: string }): Promise<DurableGeneration>
}

export class NexoClipGenerationRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'NexoClipGenerationRequestError'
  }
}

type NexoClipGenerationClientEnv = Partial<Pick<NodeJS.ProcessEnv,
  'NEXOCLIP_INTERNAL_URL'
  | 'CANVAS_AUTH_HMAC_SECRET'>>

type ClientOptions = {
  env?: NexoClipGenerationClientEnv
  now?: () => number
  createNonce?: () => string
  fetchFn?: typeof fetch
}

export function createNexoClipGenerationClient(options: ClientOptions = {}): NexoClipGenerationClient {
  const env = (options.env ?? process.env) as NexoClipGenerationClientEnv
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const createNonce = options.createNonce ?? crypto.randomUUID
  const fetchFn = options.fetchFn ?? fetch
  const request = async (
    action: 'submit' | 'status',
    input: { userId: string; projectId: string; nodeId: string; input?: DurableGenerationInput; generationId?: string },
  ): Promise<DurableGeneration> => {
    const secret = env.CANVAS_AUTH_HMAC_SECRET
    const baseUrl = env.NEXOCLIP_INTERNAL_URL?.trim().replace(/\/$/, '')
    if (!baseUrl || !secret) throw new Error('NexoClip durable generation service is unavailable')

    const actionBody = action === 'submit'
      ? { action, input: input.input! }
      : { action, generationId: input.generationId! }
    const payload = {
      userId: input.userId,
      projectId: input.projectId,
      nodeId: input.nodeId,
      timestamp: now(),
      nonce: createNonce(),
      actionDigest: createCanvasAuthorizationActionDigest(actionBody),
    }
    const signature = signCanvasAuthorization(payload, secret)
    const response = await fetchFn(`${baseUrl}/api/internal/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature, ...actionBody }),
    })

    if (!response.ok) throw new NexoClipGenerationRequestError(response.status, await safeErrorMessage(response))
    return (await response.json() as { generation: DurableGeneration }).generation
  }

  return {
    submit: (input) => request('submit', input),
    status: (input) => request('status', input),
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === 'string' ? body.error : 'NexoClip durable generation request failed'
  } catch {
    return 'NexoClip durable generation request failed'
  }
}
