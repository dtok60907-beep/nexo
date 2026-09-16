import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetRouteHandlers } from '@/app/api/assets/[assetId]/route'
import { workspaceAssetDeleteUrl } from '@/lib/workspace-asset-delete'

const PROJECT_ID = 'project-1'
const USER_ID = 'user-1'

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

test('workspace deletion is blocked when any owned Canvas references the asset', async () => {
  let proxied = false
  const handlers = createAssetRouteHandlers({
    getDb: () => sqlForWorkspaceAsset(),
    getAuthenticatedUser: async () => ({ id: USER_ID }),
    createInternalRealtimeClient: () => ({
      exportDocument: async ({ projectId }: { projectId: string }) => ({
        projection: { nodes: projectId === 'project-2' ? [{ id: 'node-1', data: { assetId: 'asset-1' } }] : [], edges: [], scenes: [] },
      }),
    }) as any,
    fetchFn: async () => { proxied = true; return Response.json({ success: true }) },
    env: { NEXOCLIP_INTERNAL_URL: 'http://nexoclip:3000' },
  } as any)

  const response = await handlers.DELETE(new Request(`http://spite.test/api/assets/asset-1?projectId=${PROJECT_ID}`, {
    method: 'DELETE', headers: { cookie: 'session=abc' },
  }), { params: Promise.resolve({ assetId: 'asset-1' }) })

  assert.equal(response.status, 403)
  assert.equal(proxied, false)
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
