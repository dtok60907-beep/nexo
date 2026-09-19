import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetRouteHandlers } from '../app/api/assets/[assetId]/route'
import { createGenerateRecoverHandler } from '../app/api/generate/recover/route'
import { createGenerateStatusHandler } from '../app/api/generate/status/route'
import { createGenerateSubmitHandler } from '../app/api/generate/submit/route'
import { createDuplicateProjectHandler } from '../app/api/projects/[projectId]/duplicate/route'
import { createCanvasSnapshotRouteHandlers } from '../app/api/projects/[projectId]/canvas/snapshots/route'
import { createAttachGeneratedMediaToNode } from './r2-upload'

const OWNER_ID = '550e8400-e29b-41d4-a716-446655440001'
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000'
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440099'

function canvasWithNode(id: string, type = 'imageGen', data: Record<string, unknown> = {}) {
  return {
    nodes: [{ id, type, position: { x: 0, y: 0 }, data }],
    edges: [],
    scenes: [{ id: 'scene-1', name: 'Scene 1' }],
    activeSceneId: 'scene-1',
  }
}

function ownedProjectSql() {
  return (async (strings: TemplateStringsArray) => {
    if (strings.join(' ').replace(/\s+/g, ' ').toLowerCase().includes('select 1 from projects where id =')) {
      return [{ ok: 1 }]
    }
    throw new Error(`Unhandled SQL: ${strings.join(' ')}`)
  }) as any
}

function makeRequest(url: string, {
  method = 'GET',
  body,
}: {
  method?: string
  body?: unknown
} = {}) {
  const headers: Record<string, string> = {}
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const request = new Request(url, { method, headers, body: payload }) as Request & { nextUrl?: URL }
  request.nextUrl = new URL(url)
  return request
}

test('submits an owned image node as a durable NexoClip generation and patches its id', async () => {
  const patches: unknown[] = []
  const submissions: unknown[] = []
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async (input) => { submissions.push(input); return { id: 'generation-1', kind: 'image', status: 'queued' } },
      status: async () => { throw new Error('status should not be called') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1'), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async (patch: unknown) => { patches.push(patch) },
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID, nodeId: 'node-1', kind: 'image', prompt: 'red kite', model: 'model-1',
      referenceImageUrl: '/reference-a.png',
      referenceGroups: [{ urls: ['/reference-b.png'] }],
      settings: { aspectRatio: '1:1', resolution: '2K', seed: 7 },
    },
  }))

  assert.equal(response.status, 202)
  assert.deepEqual((submissions[0] as any).input.parameters, {
    aspectRatio: '1:1', resolution: '2K', seed: 7,
    referenceImages: ['/reference-a.png', '/reference-b.png'],
  })
  assert.equal((patches[0] as any).userId, OWNER_ID)
  assert.equal((patches[0] as any).projectId, PROJECT_ID)
  assert.equal((patches[0] as any).nodeId, 'node-1')
  assert.deepEqual((patches[0] as any).set, {
    generationId: 'generation-1', generationStatus: 'queued', generationError: null,
    status: 'in_queue', error: null,
    submittedAt: (patches[0] as any).set.submittedAt,
  })
  assert.equal(typeof (patches[0] as any).set.submittedAt, 'number')
})

test('rejects non-portrait Seedance video settings before queueing', async () => {
  const submissions: unknown[] = []
  let checkedLegacyReferences: string[] = []
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(' ').replace(/\s+/g, ' ').toLowerCase()
      if (query.includes('select 1 from projects where id =')) return [{ ok: 1 }]
      if (query.includes('count(distinct')) {
        checkedLegacyReferences = values.find(Array.isArray) as string[]
        return [{ owned_count: 1 }]
      }
      throw new Error(`Unhandled SQL: ${strings.join(' ')}`)
    }) as any,
    createNexoClipGenerationClient: () => ({
      submit: async (input) => { submissions.push(input); return { id: 'generation-video-1', kind: 'video', status: 'queued' } },
      status: async () => { throw new Error('status should not be called') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('video-node-1', 'videoGen'), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => {},
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID, nodeId: 'video-node-1', kind: 'video', prompt: 'Nathan walking', model: 'seedance-2.0',
      referenceGroups: [{ urls: ['/spite/api/r2-image/uploads/nathan.png'] }],
      settings: { aspectRatio: '16:9', duration: '5s', resolution: '720p' },
    },
  }))

  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /portrait-only/i)
  assert.deepEqual(submissions, [])
  assert.deepEqual(checkedLegacyReferences, ['/api/r2-image/uploads/nathan.png'])
})

test('rejects legacy Canvas references outside the owned project', async () => {
  let submitted = false
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: () => (async (strings: TemplateStringsArray) => {
      const query = strings.join(' ').replace(/\s+/g, ' ').toLowerCase()
      if (query.includes('select 1 from projects where id =')) return [{ ok: 1 }]
      if (query.includes('count(distinct')) return [{ owned_count: 0 }]
      throw new Error(`Unhandled SQL: ${strings.join(' ')}`)
    }) as any,
    createNexoClipGenerationClient: () => ({
      submit: async () => { submitted = true; throw new Error('submit should not be called') },
      status: async () => { throw new Error('status should not be called') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('video-node-1', 'videoGen'), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => {},
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID, nodeId: 'video-node-1', kind: 'video', prompt: 'Nathan walking', model: 'seedance-2.0',
      referenceGroups: [{ urls: ['/spite/api/r2-image/uploads/not-owned.png'] }],
      settings: { duration: '5s' },
    },
  }))

  assert.equal(response.status, 404)
  assert.equal(submitted, false)
})

test('rejects a second submit while its canvas node has an active durable generation', async () => {
  let submitted = false
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async () => { submitted = true; throw new Error('submit should not be called') },
      status: async () => { throw new Error('status should not be called') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1', 'imageGen', { generationId: 'existing-job', generationStatus: 'queued' }), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => {},
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: { projectId: PROJECT_ID, nodeId: 'node-1', kind: 'image', prompt: 'red kite', model: 'nano-banana' },
  }))

  assert.equal(response.status, 409)
  assert.equal(submitted, false)
})

test('normalizes Canvas-only image controls for the durable generation API', async () => {
  const submissions: unknown[] = []
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async (input) => { submissions.push(input); return { id: 'generation-1', kind: 'image', status: 'queued' } },
      status: async () => { throw new Error('status should not be called') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1'), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => {},
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID, nodeId: 'node-1', kind: 'image', prompt: 'red kite', model: 'nano-banana-2',
      settings: { aspectRatio: 'auto', resolution: '1K' },
    },
  }))

  assert.equal(response.status, 202)
  assert.equal((submissions[0] as any).input.model, 'google/gemini-3.1-flash-image')
  assert.deepEqual((submissions[0] as any).input.parameters, { resolution: '1K' })
})

test('returns a terminal durable failure even when realtime reconciliation is unavailable', async () => {
  const handler = createGenerateStatusHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async () => { throw new Error('submit should not be called') },
      status: async () => ({ id: 'g1', kind: 'image', status: 'failed', error: { message: 'provider rejected request' } }),
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1', 'imageGen', { generationId: 'g1' }), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => { throw new Error('realtime temporarily unavailable') },
    }) as any,
  })

  const response = await handler(makeRequest(`http://spite.local/api/generate/status?projectId=${PROJECT_ID}&nodeId=node-1&generationId=g1`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { generationId: 'g1', generationStatus: 'failed', error: 'provider rejected request' })
})

test('omits blank optional image settings so durable defaults apply', async () => {
  const submissions: unknown[] = []
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async (input) => { submissions.push(input); return { id: 'generation-1', kind: 'image', status: 'queued' } },
      status: async () => { throw new Error('status should not be called') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1'), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => {},
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID, nodeId: 'node-1', kind: 'image', prompt: 'red kite', model: 'model-1',
      settings: { aspectRatio: '', resolution: '' },
    },
  }))

  assert.equal(response.status, 202)
  assert.deepEqual((submissions[0] as any).input.parameters, {})
})

test('rejects unsupported legacy controls before creating a durable job', async () => {
  let submitted = false
  const handler = createGenerateSubmitHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async () => { submitted = true; throw new Error('must not submit') },
      status: async () => { throw new Error('must not poll') },
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1'), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async () => {},
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: { projectId: PROJECT_ID, nodeId: 'node-1', kind: 'image', prompt: 'red kite', model: 'model-1', settings: { enableAudio: true } },
  }))

  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /enableAudio/)
  assert.equal(submitted, false)
})

test('writes a successful durable generation result to the owned canvas node once', async () => {
  const patches: unknown[] = []
  const handler = createGenerateStatusHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async () => { throw new Error('submit should not be called') },
      status: async () => ({

        id: 'g1', kind: 'image', status: 'succeeded',
        outputs: [{ assetId: 'a', download: { url: '/api/assets/a/download' } }],
      }),
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1', 'imageGen', { generationId: 'g1', generationStatus: 'processing' }), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async (patch: unknown) => { patches.push(patch) },
    }) as any,
  })

  const response = await handler(makeRequest(`http://spite.local/api/generate/status?projectId=${PROJECT_ID}&nodeId=node-1&generationId=g1`))

  assert.equal(response.status, 200)
  assert.deepEqual(patches[0], {
    userId: OWNER_ID, projectId: PROJECT_ID, nodeId: 'node-1',
    set: { lastGenerationId: 'g1', generationStatus: 'completed', outputUrl: '/api/assets/a/download', status: 'completed', error: null, generationError: null },
    unset: ['generationId'],
  })
})

test('returns an idempotent terminal result after its active generation marker is cleared', async () => {
  const patches: unknown[] = []
  const handler = createGenerateStatusHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getDb: ownedProjectSql,
    createNexoClipGenerationClient: () => ({
      submit: async () => { throw new Error('submit should not be called') },
      status: async () => ({

        id: 'g1', kind: 'image', status: 'succeeded',
        outputs: [{ assetId: 'a', download: { url: '/api/assets/a/download' } }],
      }),
    }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: canvasWithNode('node-1', 'imageGen', {
        lastGenerationId: 'g1', generationStatus: 'completed', outputUrl: '/api/assets/a/download', status: 'completed', error: null, generationError: null,
      }), durableSeq: 1, projectedSeq: 1 }),
      patchNodeData: async (patch: unknown) => { patches.push(patch) },
    }) as any,
  })

  const response = await handler(makeRequest(`http://spite.local/api/generate/status?projectId=${PROJECT_ID}&nodeId=node-1&generationId=g1`))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    generationId: 'g1', generationStatus: 'completed', outputUrl: '/api/assets/a/download',
  })
  assert.equal(patches.length, 0)
})

test('attachGeneratedMediaToNode routes generation completion through authoritative realtime patching', async () => {
  const calls: unknown[] = []
  const attach = createAttachGeneratedMediaToNode({
    createInternalRealtimeClient: () => ({
      patchNodeData: async (input: unknown) => {
        calls.push(input)
      },
    }) as any,
  })

  await attach({
    userId: OWNER_ID,
    projectId: PROJECT_ID,
    nodeId: 'node-1',
    url: '/uploads/generated.png',
  })

  assert.deepEqual(calls, [{
    userId: OWNER_ID,
    projectId: PROJECT_ID,
    nodeId: 'node-1',
    set: {
      outputUrl: '/uploads/generated.png',
      status: 'completed',
      error: null,
    },
    unset: ['pendingRequestId', 'pendingProvider', 'pendingProviderModel', 'pendingFalEndpoint', 'pendingStartedAt'],
  }])
})

test('snapshot restore routes through authoritative realtime document replacement', async () => {
  const replaceCalls: unknown[] = []
  const exportCalls: unknown[] = []
  const handlers = createCanvasSnapshotRouteHandlers({
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
        return [{ ok: 1 }]
      }

      if (normalized.includes('select id, nodes_json, edges_json from canvas_snapshots where project_id = ? and id = ?') && normalized.includes('limit 1')) {
        return [{
          id: SNAPSHOT_ID,
          nodes_json: [{ id: 'restored-node', type: 'imageGen', position: { x: 10, y: 20 }, data: { label: 'restored' } }],
          edges_json: [{ id: 'edge-1', source: 'restored-node', target: 'restored-node', data: {} }],
        }]
      }

      if (normalized.startsWith('insert into canvas_snapshots')) {
        return []
      }

      if (normalized.startsWith('delete from canvas_snapshots')) {
        return []
      }

      throw new Error(`Unhandled SQL in snapshot restore test: ${normalized}`)
    }) as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    createInternalRealtimeClient: () => ({
      exportDocument: async (input: unknown) => {
        exportCalls.push(input)
        return {
          durableSeq: 4,
          projectedSeq: 4,
          projection: {
            nodes: [{ id: 'current-node', type: 'prompt', position: { x: 0, y: 0 }, data: { label: 'current' } }],
            edges: [],
            scenes: [{ id: 'scene-1', name: 'Scene 1' }],
            activeSceneId: 'scene-1',
          },
        }
      },
      replaceDocument: async (input: unknown) => {
        replaceCalls.push(input)
      },
    }) as any,
  })

  const response = await handlers.POST(makeRequest(`http://spite.local/api/projects/${PROJECT_ID}/canvas/snapshots`, {
    method: 'POST',
    body: { snapshotId: SNAPSHOT_ID },
  }) as any, { params: Promise.resolve({ projectId: PROJECT_ID }) } as any)

  assert.equal(response.status, 200)
  assert.deepEqual(exportCalls, [{ userId: OWNER_ID, projectId: PROJECT_ID }])
  assert.deepEqual(replaceCalls, [{
    userId: OWNER_ID,
    projectId: PROJECT_ID,
    projection: {
      nodes: [{ id: 'restored-node', type: 'imageGen', position: { x: 10, y: 20 }, data: { label: 'restored' } }],
      edges: [{ id: 'edge-1', source: 'restored-node', target: 'restored-node', data: {} }],
      scenes: [{ id: 'scene-1', name: 'Scene 1' }],
      activeSceneId: 'scene-1',
    },
  }])
})

test('duplicate project clones authoritative document instead of copying projection tables directly', async () => {
  const exportCalls: unknown[] = []
  const replaceCalls: unknown[] = []
  const handler = createDuplicateProjectHandler({
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
        return [{ ok: 1 }]
      }

      if (normalized.startsWith("select name, description, thumbnail, coalesce(origin, 'canvas') as origin from projects where id = ?")) {
        return [{ name: 'Storyboard', description: '', thumbnail: null, origin: 'canvas' }]
      }

      if (normalized.startsWith('insert into projects')) {
        return [{ id: 'copy-project', name: 'Storyboard (Copy)' }]
      }

      throw new Error(`Unhandled SQL in duplicate test: ${normalized}`)
    }) as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    createProjectId: () => 'copy-project',
    createInternalRealtimeClient: () => ({
      exportDocument: async (input: unknown) => {
        exportCalls.push(input)
        return {
          durableSeq: 9,
          projectedSeq: 9,
          projection: {
            nodes: [{ id: 'source-node', type: 'prompt', position: { x: 1, y: 2 }, data: { label: 'hello' } }],
            edges: [],
            scenes: [{ id: 'scene-1', name: 'Scene 1' }],
            activeSceneId: 'scene-1',
          },
        }
      },
      replaceDocument: async (input: unknown) => {
        replaceCalls.push(input)
      },
    }) as any,
  })

  const response = await handler(makeRequest(`http://spite.local/api/projects/${PROJECT_ID}/duplicate`, {
    method: 'POST',
  }) as any, { params: Promise.resolve({ projectId: PROJECT_ID }) } as any)

  assert.equal(response.status, 200)
  assert.deepEqual(exportCalls, [{ userId: OWNER_ID, projectId: PROJECT_ID }])
  assert.deepEqual(replaceCalls, [{
    userId: OWNER_ID,
    projectId: 'copy-project',
    projection: {
      nodes: [{ id: 'source-node', type: 'prompt', position: { x: 1, y: 2 }, data: { label: 'hello' } }],
      edges: [],
      scenes: [{ id: 'scene-1', name: 'Scene 1' }],
      activeSceneId: 'scene-1',
    },
  }])
})

test('duplicate exports before insert and deletes the inserted project when authoritative replace fails', async () => {
  const operations: string[] = []
  const handler = createDuplicateProjectHandler({
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
        operations.push('owns-project')
        return [{ ok: 1 }]
      }

      if (normalized.startsWith("select name, description, thumbnail, coalesce(origin, 'canvas') as origin from projects where id = ?")) {
        operations.push('load-source-project')
        return [{ name: 'Storyboard', description: '', thumbnail: null, origin: 'canvas' }]
      }

      if (normalized.startsWith('insert into projects')) {
        operations.push('insert-copy')
        return [{ id: 'copy-project', name: 'Storyboard (Copy)' }]
      }

      if (normalized.startsWith('delete from projects where id = ? and userid = ?')) {
        operations.push('delete-orphan-copy')
        return []
      }

      throw new Error(`Unhandled SQL in duplicate cleanup test: ${normalized}`)
    }) as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    createProjectId: () => 'copy-project',
    createInternalRealtimeClient: () => ({
      exportDocument: async (input: unknown) => {
        operations.push('export-authoritative')
        return {
          durableSeq: 9,
          projectedSeq: 9,
          projection: {
            nodes: [{ id: 'source-node', type: 'prompt', position: { x: 1, y: 2 }, data: { label: 'hello' } }],
            edges: [],
            scenes: [{ id: 'scene-1', name: 'Scene 1' }],
            activeSceneId: 'scene-1',
          },
        }
      },
      replaceDocument: async () => {
        operations.push('replace-authoritative')
        throw new Error('replace failed')
      },
    }) as any,
  })

  const response = await handler(makeRequest(`http://spite.local/api/projects/${PROJECT_ID}/duplicate`, {
    method: 'POST',
  }) as any, { params: Promise.resolve({ projectId: PROJECT_ID }) } as any)

  assert.equal(response.status, 500)
  assert.deepEqual(operations, [
    'owns-project',
    'load-source-project',
    'export-authoritative',
    'insert-copy',
    'replace-authoritative',
    'delete-orphan-copy',
  ])
})

test('generate/recover discovers pending Yjs nodes from authoritative exports when projection data is absent or lagging', async () => {
  const exportCalls: unknown[] = []
  const patchCalls: unknown[] = []
  const laggingProjectId = '550e8400-e29b-41d4-a716-4466554400aa'
  const currentProjectId = '550e8400-e29b-41d4-a716-4466554400bb'

  const handler = createGenerateRecoverHandler({
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.includes('select c.projectid, c.nodeid, c.data, c.type from canvas_nodes c join projects p on p.id::text = c.projectid') && normalized.includes('where p.userid = ?') && normalized.includes("c.data->>'pendingrequestid' is not null") && normalized.includes("c.data->>'pendingfalendpoint' is not null")) {
        return []
      }

      if (normalized.includes('select p.id as project_id, d.durable_seq, d.projected_seq from projects p left join canvas_yjs_documents d on d.project_id = p.id::text') && normalized.includes('where p.userid = ?')) {
        return [
          { project_id: laggingProjectId, durable_seq: 5, projected_seq: 4 },
          { project_id: currentProjectId, durable_seq: 3, projected_seq: 3 },
        ]
      }

      throw new Error(`Unhandled SQL in authoritative recovery discovery test: ${normalized}`)
    }) as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    falKey: 'test-fal-key',
    fetchFalStatus: async (requestId) => {
      if (requestId === 'req-yjs-pending') return Response.json({ status: 'FAILED' })
      throw new Error(`unexpected requestId: ${requestId}`)
    },
    fetchFalResult: async () => Response.json({}),
    createInternalRealtimeClient: () => ({
      exportDocument: async (input: { userId: string; projectId: string }) => {
        exportCalls.push(input)
        if (input.projectId === laggingProjectId) {
          return {
            durableSeq: 5,
            projectedSeq: 4,
            projection: {
              nodes: [{
                id: 'node-yjs-only',
                type: 'imageGen',
                position: { x: 10, y: 20 },
                data: {
                  pendingRequestId: 'req-yjs-pending',
                  pendingFalEndpoint: 'fal-ai/flux/dev',
                  prompt: 'recover authoritative node',
                },
              }],
              edges: [],
              scenes: [{ id: 'scene-1', name: 'Scene 1' }],
              activeSceneId: 'scene-1',
            },
          }
        }

        return {
          durableSeq: 3,
          projectedSeq: 3,
          projection: {
            nodes: [],
            edges: [],
            scenes: [{ id: 'scene-1', name: 'Scene 1' }],
            activeSceneId: 'scene-1',
          },
        }
      },
      patchNodeData: async (input: unknown) => {
        patchCalls.push(input)
      },
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/recover', {
    method: 'POST',
    body: {},
  }) as any)

  assert.equal(response.status, 200)
  assert.deepEqual(exportCalls, [{ userId: OWNER_ID, projectId: laggingProjectId }])
  assert.deepEqual(patchCalls, [{
    userId: OWNER_ID,
    projectId: laggingProjectId,
    nodeId: 'node-yjs-only',
    unset: ['pendingRequestId', 'pendingFalEndpoint', 'pendingStartedAt'],
  }])
})

test('generate/recover bulk cleanup clears pending markers via authoritative realtime patching', async () => {
  const patchCalls: unknown[] = []
  const handler = createGenerateRecoverHandler({
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
        return [{ ok: 1 }]
      }

      if (normalized.includes('select projectid, nodeid, data, type from canvas_nodes where projectid = ?') && normalized.includes("data->>'pendingrequestid' is not null") && normalized.includes("data->>'pendingfalendpoint' is not null")) {
        return [{
          projectid: PROJECT_ID,
          nodeid: 'node-1',
          type: 'imageGen',
          data: {
            pendingRequestId: 'req-123',
            pendingFalEndpoint: 'fal-ai/flux/dev',
            prompt: 'recover me',
          },
        }]
      }

      if (normalized.includes('select p.id as project_id, d.durable_seq, d.projected_seq from projects p left join canvas_yjs_documents d on d.project_id = p.id::text') && normalized.includes('where p.userid = ?') && normalized.includes('and p.id = ?')) {
        return [{ project_id: PROJECT_ID, durable_seq: 1, projected_seq: 1 }]
      }

      throw new Error(`Unhandled SQL in generate/recover task 17 test: ${normalized}`)
    }) as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    falKey: 'test-fal-key',
    fetchFalStatus: async () => Response.json({ status: 'FAILED' }),
    fetchFalResult: async () => Response.json({}),
    createInternalRealtimeClient: () => ({
      patchNodeData: async (input: unknown) => {
        patchCalls.push(input)
      },
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/recover', {
    method: 'POST',
    body: { projectId: PROJECT_ID },
  }) as any)

  assert.equal(response.status, 200)
  assert.deepEqual(patchCalls, [{
    userId: OWNER_ID,
    projectId: PROJECT_ID,
    nodeId: 'node-1',
    unset: ['pendingRequestId', 'pendingFalEndpoint', 'pendingStartedAt'],
  }])
})

test('asset delete consults authoritative document when projection lags before removing media', async () => {
  const exportCalls: unknown[] = []
  const handlers = createAssetRouteHandlers({
    getDb: () => (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.startsWith('select g.id, g.project_id, g.r2_url from generation_history g join projects p on p.id::text = g.project_id::text where p.userid = ? and g.id::text = ? limit 1')) {
        return [{ id: 'asset-1', project_id: PROJECT_ID, r2_url: '/uploads/generated.png' }]
      }

      if (normalized.startsWith('delete from asset_folder_items where asset_id = ? returning folder_id')) {
        return []
      }

      if (normalized.startsWith('select durable_seq, projected_seq from canvas_yjs_documents where project_id = ?')) {
        return [{ durable_seq: 7, projected_seq: 6 }]
      }

      if (normalized.startsWith('update generation_history set used_in_canvas = true, expires_at = null where id = ? and project_id = ?') || normalized.startsWith('update generation_history set used_in_canvas = ?, expires_at = ? where id = ? and project_id = ?')) {
        return []
      }

      throw new Error(`Unhandled SQL in asset delete lag test: ${normalized}`)
    }) as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getR2Client: () => ({ send: async () => { throw new Error('R2 delete should not run when authoritative doc still references asset') } }) as any,
    createInternalRealtimeClient: () => ({
      exportDocument: async (input: unknown) => {
        exportCalls.push(input)
        return {
          durableSeq: 7,
          projectedSeq: 6,
          projection: {
            nodes: [{
              id: 'node-1',
              type: 'imageGen',
              position: { x: 0, y: 0 },
              data: {
                assetId: 'asset-1',
                outputUrl: '/uploads/generated.png',
              },
            }],
            edges: [],
            scenes: [{ id: 'scene-1', name: 'Scene 1' }],
            activeSceneId: 'scene-1',
          },
        }
      },
    }) as any,
  })

  const response = await handlers.DELETE(makeRequest('http://spite.local/api/assets/asset-1', {
    method: 'DELETE',
  }) as any, { params: Promise.resolve({ assetId: 'asset-1' }) } as any)

  assert.equal(response.status, 200)
  assert.deepEqual(exportCalls, [{ userId: OWNER_ID, projectId: PROJECT_ID }])
  assert.deepEqual(await response.json(), {
    success: true,
    kept: true,
    reason: 'still_on_canvas',
    removed_from_folders: 0,
    deleted_folders: 0,
  })
})
