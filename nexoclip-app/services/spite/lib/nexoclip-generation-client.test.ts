import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNexoClipGenerationClient,
  NexoClipGenerationRequestError,
  type DurableGenerationInput,
} from './nexoclip-generation-client'

const imageInput: DurableGenerationInput = {
  kind: 'image',
  prompt: 'red kite',
  model: 'google/gemini-image',
  parameters: { aspectRatio: '1:1' },
  idempotencyKey: 'spite:project-1:node-1:nonce-1',
}

test('signs a durable submit request to the private NexoClip bridge', async () => {
  const requests: RequestInit[] = []
  const client = createNexoClipGenerationClient({
    env: { NEXOCLIP_INTERNAL_URL: 'http://nexoclip:3000', CANVAS_AUTH_HMAC_SECRET: 'secret' },
    now: () => 100,
    createNonce: () => 'nonce-1',
    fetchFn: async (_url, init) => {
      requests.push(init!)
      return Response.json({ generation: { id: 'generation-1', status: 'queued', kind: 'image' } })
    },
  })

  await client.submit({ userId: 'user-1', projectId: 'project-1', nodeId: 'node-1', input: imageInput })

  const body = JSON.parse(String(requests[0].body))
  assert.equal(body.action, 'submit')
  assert.equal(body.input.idempotencyKey, imageInput.idempotencyKey)
  assert.equal(typeof body.signature, 'string')
})

test('throws a typed error for a non-OK durable status response', async () => {
  const client = createNexoClipGenerationClient({
    env: { NEXOCLIP_INTERNAL_URL: 'http://nexoclip:3000', CANVAS_AUTH_HMAC_SECRET: 'secret' },
    now: () => 100,
    createNonce: () => 'nonce-1',
    fetchFn: async () => Response.json({ error: 'Generation not found' }, { status: 404 }),
  })

  await assert.rejects(
    () => client.status({ userId: 'user-1', projectId: 'project-1', nodeId: 'node-1', generationId: 'missing' }),
    (error: unknown) => error instanceof NexoClipGenerationRequestError && error.status === 404,
  )
})
