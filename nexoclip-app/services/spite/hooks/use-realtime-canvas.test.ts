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

function node(id: string, data: Record<string, unknown>): TestNode {
  return { id, data }
}

function syncedProviderWithNodes(nodes: TestNode[]): (configuration: HocuspocusProviderConfiguration) => SyncableProvider {
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
      sync: () => configuration.onSynced?.({ state: true } as never),
    }
  }
}

test('requests status once for each in-flight durable media node after sync', async () => {
  const fetches: Array<{ url: string; init?: RequestInit }> = []
  let provider: SyncableProvider | undefined
  const room = new RealtimeCanvasRoom('project-1', {
    fetchFn: async (url, init) => {
      fetches.push({ url: String(url), init })
      return Response.json({ generationId: 'g1', generationStatus: 'processing' })
    },
    createProvider: (configuration) => {
      provider = syncedProviderWithNodes([
        node('image-1', { generationId: 'g1', generationStatus: 'queued' }),
        node('image-2', { generationId: 'g2', generationStatus: 'completed' }),
      ])(configuration)
      return provider
    },
  })

  provider?.sync()
  await Promise.resolve()
  await room.recoverDurableGenerations()

  assert.equal(fetches.length, 1)
  assert.match(fetches[0].url, /projectId=project-1/)
  assert.match(fetches[0].url, /nodeId=image-1/)
  assert.match(fetches[0].url, /generationId=g1/)
  assert.deepEqual(fetches[0].init, { credentials: 'include' })

  room.destroy()
})
