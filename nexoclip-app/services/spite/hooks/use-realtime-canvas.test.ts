import assert from 'node:assert/strict'
import test from 'node:test'
import type { HocuspocusProviderConfiguration } from '@hocuspocus/provider'
import type * as Y from 'yjs'

import { RealtimeCanvasRoom } from './use-realtime-canvas'
import { upsertNode } from '../lib/realtime/document'

type TestNode = {
  id: string
  data: Record<string, unknown>
}

type SyncableProvider = {
  awareness: null
  destroy: () => void
  sync: () => void
}

type FetchResponse = { generationStatus: string } | Error

function node(id: string, data: Record<string, unknown>): TestNode {
  return { id, data }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function providerWithNodes(
  nodes: TestNode[],
  onSync?: (document: Y.Doc) => void,
): (configuration: HocuspocusProviderConfiguration) => SyncableProvider {
  return (configuration) => {
    const document = configuration.document as Y.Doc
    for (const entry of nodes) {
      upsertNode(document, {
        id: entry.id,
        type: 'imageGen',
        position: { x: 0, y: 0 },
        data: entry.data,
      })
    }

    return {
      awareness: null,
      destroy: () => {},
      sync: () => {
        configuration.onSynced?.({ state: true } as never)
        onSync?.(document)
      },
    }
  }
}

function statusFetch(
  responses: FetchResponse[],
  fetches: Array<{ url: string; init?: RequestInit }>,
): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    fetches.push({ url: String(url), init })
    const response = responses.shift()
    if (response instanceof Error) throw response
    return Response.json(response ?? { generationStatus: 'processing' })
  }
}

test('defers durable recovery until initial sync and ignores terminal nodes', async () => {
  const fetches: Array<{ url: string; init?: RequestInit }> = []
  let provider: SyncableProvider | undefined
  const room = new RealtimeCanvasRoom('project-1', {
    fetchFn: statusFetch([{ generationStatus: 'processing' }], fetches),
    createProvider: (configuration) => {
      provider = providerWithNodes([
        node('image-1', { generationId: 'g1', generationStatus: 'queued' }),
        node('image-2', { generationId: 'g2', generationStatus: 'completed' }),
      ])(configuration)
      return provider
    },
  })

  assert.equal(fetches.length, 0)

  provider?.sync()
  await flush()

  assert.equal(fetches.length, 1)
  assert.match(fetches[0].url, /projectId=project-1/)
  assert.match(fetches[0].url, /nodeId=image-1/)
  assert.match(fetches[0].url, /generationId=g1/)
  assert.doesNotMatch(fetches[0].url, /nodeId=image-2/)
  assert.deepEqual(fetches[0].init, { credentials: 'include' })

  room.destroy()
})

test('deduplicates concurrent sync and snapshot recovery triggers', async () => {
  const fetches: Array<{ url: string; init?: RequestInit }> = []
  let provider: SyncableProvider | undefined
  const room = new RealtimeCanvasRoom('project-1', {
    fetchFn: statusFetch([{ generationStatus: 'processing' }], fetches),
    createProvider: (configuration) => {
      provider = providerWithNodes(
        [node('image-1', { generationId: 'g1', generationStatus: 'queued' })],
        (document) => {
          upsertNode(document, {
            id: 'image-1',
            type: 'imageGen',
            position: { x: 1, y: 0 },
            data: { generationId: 'g1', generationStatus: 'queued' },
          })
        },
      )(configuration)
      return provider
    },
  })

  provider?.sync()
  await flush()

  assert.equal(fetches.length, 1)
  room.destroy()
})

test('releases recovery keys after terminal responses and errors', async () => {
  const fetches: Array<{ url: string; init?: RequestInit }> = []
  let provider: SyncableProvider | undefined
  const room = new RealtimeCanvasRoom('project-1', {
    fetchFn: statusFetch([
      { generationStatus: 'completed' },
      new Error('network failure'),
      { generationStatus: 'processing' },
    ], fetches),
    createProvider: (configuration) => {
      provider = providerWithNodes([
        node('image-1', { generationId: 'g1', generationStatus: 'queued' }),
      ])(configuration)
      return provider
    },
  })

  provider?.sync()
  await flush()
  await room.recoverDurableGenerations()
  await room.recoverDurableGenerations()

  assert.equal(fetches.length, 3)
  room.destroy()
})
