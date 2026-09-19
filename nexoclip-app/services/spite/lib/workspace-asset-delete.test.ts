import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createAssetRouteHandlers } from '@/app/api/assets/[assetId]/route'
import { workspaceAssetDeleteUrl, workspaceAssetReferencePatches } from '@/lib/workspace-asset-delete'

const PROJECT_ID = 'project-1'
const USER_ID = 'user-1'
const assetRouteSource = readFileSync(new URL('../app/api/assets/[assetId]/route.ts', import.meta.url), 'utf8')

function sqlForWorkspaceAsset() {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (query.includes('from generation_history')) return []
    if (query.includes('select 1 from projects')) return [{ ok: 1 }]
    if (query.includes('select id::text as id from projects')) return [{ id: PROJECT_ID }, { id: 'project-2' }]
    if (query.startsWith('delete from asset_folder_items')) return []
    throw new Error(`Unhandled SQL: ${query}`)
  }) as any
}

test('internal cleanup takes precedence over a colliding legacy generation id', async () => {
  let queriedGeneration = false
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (query.includes('from generation_history')) {
      queriedGeneration = true
      return [{ id: 'asset-1', project_id: PROJECT_ID, r2_url: 'legacy.png' }]
    }
    if (query.includes('select id::text as id from projects')) return [{ id: PROJECT_ID }]
    if (query.startsWith('delete from asset_folder_items')) return []
    throw new Error(`Unhandled SQL: ${query}`)
  }) as any
  const handlers = createAssetRouteHandlers({
    getDb: () => sql,
    getAuthenticatedUser: async () => ({ id: USER_ID }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: { nodes: [], edges: [], scenes: [] } }),
    }) as any,
  })

  const response = await handlers.DELETE(new Request('http://spite.test/api/assets/asset-1?cleanup=1', {
    method: 'DELETE',
  }), { params: Promise.resolve({ assetId: 'asset-1' }) })

  assert.equal(response.status, 200)
  assert.equal(queriedGeneration, false)
})

test('canonical workspace deletion takes precedence over a colliding legacy generation id', async () => {
  let proxied = false
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (query.includes('from generation_history')) {
      return [{ id: 'asset-1', project_id: PROJECT_ID, r2_url: 'legacy.png' }]
    }
    if (query.includes('select 1 from projects')) return [{ ok: 1 }]
    throw new Error(`Unhandled SQL: ${query}`)
  }) as any
  const handlers = createAssetRouteHandlers({
    getDb: () => sql,
    getAuthenticatedUser: async () => ({ id: USER_ID }),
    fetchFn: async () => {
      proxied = true
      return Response.json({ success: true })
    },
    env: { NEXOCLIP_INTERNAL_URL: 'http://nexoclip:3000' },
  } as any)

  const response = await handlers.DELETE(new Request(`http://spite.test/api/assets/asset-1?projectId=${PROJECT_ID}`, {
    method: 'DELETE', headers: { cookie: 'session=abc' },
  }), { params: Promise.resolve({ assetId: 'asset-1' }) })

  assert.equal(response.status, 200)
  assert.equal(proxied, true)
})

test('internal cleanup removes canonical Canvas references before local deletion', async () => {
  const patched: any[] = []
  let proxied = false
  const handlers = createAssetRouteHandlers({
    getDb: () => sqlForWorkspaceAsset(),
    getAuthenticatedUser: async () => ({ id: USER_ID }),
    createInternalRealtimeClient: () => ({
      exportDocument: async ({ projectId }: { projectId: string }) => ({
        projection: { nodes: projectId === 'project-2' ? [{ id: 'node-1', data: { workspaceAssetId: 'asset-1', outputUrl: '/api/assets/asset-1/download' } }] : [], edges: [], scenes: [] },
      }),
      patchNodeData: async (input: any) => { patched.push(input) },
    }) as any,
    fetchFn: async () => { proxied = true; return Response.json({ success: true }) },
    env: { NEXOCLIP_INTERNAL_URL: 'http://nexoclip:3000' },
  } as any)

  const response = await handlers.DELETE(new Request('http://spite.test/api/assets/asset-1?cleanup=1', {
    method: 'DELETE', headers: { cookie: 'session=abc' },
  }), { params: Promise.resolve({ assetId: 'asset-1' }) })

  assert.equal(response.status, 200)
  assert.equal(proxied, false)
  assert.deepEqual(patched[0].unset.sort(), ['outputUrl', 'workspaceAssetId'])
})

test('workspace folder cleanup compares UUID identities safely', () => {
  assert.match(assetRouteSource, /workspace_asset_id::text = \$\{assetId\}/)
})

test('reference patching clears legacy media URLs when the node has the exact canonical identity', () => {
  const patches = workspaceAssetReferencePatches({ nodes: [
    { id: 'target', data: { workspaceAssetId: 'asset-1', outputUrl: '/spite/api/r2-image/uploads/legacy.png', thumbnail: '/spite/api/r2-image/uploads/legacy-thumb.png' } },
    { id: 'other', data: { workspaceAssetId: 'asset-2', outputUrl: '/spite/api/r2-image/uploads/legacy.png' } },
  ] } as any, 'asset-1')

  assert.equal(patches.length, 1)
  assert.equal(patches[0].nodeId, 'target')
  assert.deepEqual(patches[0].unset.sort(), ['outputUrl', 'thumbnail', 'workspaceAssetId'])
})

test('reference patching removes only exact canonical identities and mention selections', () => {
  const patches = workspaceAssetReferencePatches({ nodes: [
    { id: 'target', data: { workspaceAssetId: 'asset-1', thumbnail: '/api/assets/asset-1/download', mentions: [{ name: 'A', selectedWorkspaceAssetIds: ['asset-1', 'asset-2'] }] } },
    { id: 'other', data: { workspaceAssetId: 'asset-2', outputUrl: '/api/assets/asset-2/download' } },
  ] } as any, 'asset-1')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].nodeId, 'target')
  assert.deepEqual(patches[0].unset.sort(), ['thumbnail', 'workspaceAssetId'])
  assert.deepEqual(patches[0].set.mentions[0].selectedWorkspaceAssetIds, ['asset-2'])
})

test('workspace deletion proxies to the main app after Canvas ownership checks', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const handlers = createAssetRouteHandlers({
    getDb: () => sqlForWorkspaceAsset(),
    getAuthenticatedUser: async () => ({ id: USER_ID }),
    createInternalRealtimeClient: () => ({
      exportDocument: async () => ({ projection: { nodes: [], edges: [], scenes: [] } }),
    }) as any,
    fetchFn: async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Response.json({ success: true })
    },
    env: { NEXOCLIP_INTERNAL_URL: 'http://nexoclip:3000' },
  } as any)

  const response = await handlers.DELETE(new Request(`http://spite.test/api/assets/asset-1?projectId=${PROJECT_ID}`, {
    method: 'DELETE', headers: { cookie: 'session=abc' },
  }), { params: Promise.resolve({ assetId: 'asset-1' }) })

  assert.equal(response.status, 200)
  assert.equal(calls[0].url, 'http://nexoclip:3000/api/assets/asset-1')
  assert.equal(new Headers(calls[0].init?.headers).get('cookie'), 'session=abc')
})

test('asset delete URL carries project ownership context', () => {
  assert.equal(workspaceAssetDeleteUrl('asset/1', 'project 1', '/spite'), '/spite/api/assets/asset%2F1?projectId=project%201')
})
