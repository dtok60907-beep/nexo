import assert from 'node:assert/strict'
import test from 'node:test'

import { createProjectAssetUploadHandlers } from '@/app/api/projects/[projectId]/assets/upload/route'
import { createFoldersRouteHandlers } from '@/app/api/folders/route'
import { createFolderRouteHandlers } from '@/app/api/folders/[folderId]/route'
import { createGenerateRecoverHandler } from '@/app/api/generate/recover/route'
import { createAssetByUrlRouteHandlers } from '@/app/api/assets/by-url/route'
import { createAssetRouteHandlers } from '@/app/api/assets/[assetId]/route'
import { createAuthCheckHandler } from '@/app/api/auth/check/route'

const OWNER_ID = '550e8400-e29b-41d4-a716-446655440001'
const OTHER_ID = '550e8400-e29b-41d4-a716-446655440002'
const OWNER_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440099'

function makeRequest(url: string, {
  method = 'GET',
  body,
  headers = {},
}: {
  method?: string
  body?: unknown
  headers?: Record<string, string>
} = {}) {
  const requestHeaders = new Headers(headers)
  let payload: string | undefined
  if (body !== undefined) {
    requestHeaders.set('content-type', 'application/json')
    payload = JSON.stringify(body)
  }

  return new Request(url, { method, headers: requestHeaders, body: payload })
}

test('assets/[assetId] hides foreign assets and only deletes owned stored keys', async () => {
  const r2Deletes: string[] = []
  let deleteRowCalled = false
  let emptyFolderDeleted = false
  let sawProjectionLagCheck = false

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from generation_history g join projects p on p.id::text = g.project_id')) {
      const userId = String(values[0])
      const assetId = String(values[1])
      if (userId === OWNER_ID && assetId === 'owned-asset') {
        return [{ id: 'owned-asset', project_id: OWNER_PROJECT_ID, r2_url: '/api/r2-image/uploads/owned.png' }]
      }
      return []
    }

    if (normalized.startsWith('delete from asset_folder_items where asset_id = ? returning folder_id')) {
      return [{ folder_id: '550e8400-e29b-41d4-a716-446655440001' }]
    }

    if (normalized.startsWith('delete from asset_folders f') && normalized.includes('not exists')) {
      emptyFolderDeleted = true
      assert.deepEqual(values[0], ['550e8400-e29b-41d4-a716-446655440001'])
      return [{ id: '550e8400-e29b-41d4-a716-446655440001' }]
    }

    if (normalized.startsWith('select durable_seq, projected_seq from canvas_yjs_documents where project_id = ?')) {
      sawProjectionLagCheck = true
      assert.equal(String(values[0]), OWNER_PROJECT_ID)
      return [{ durable_seq: 3, projected_seq: 3 }]
    }

    if (normalized.includes("select 1 from canvas_nodes where projectid = ?") && normalized.includes("data->>'assetid' = ?") && normalized.includes("data->>'outputurl' = ?") && normalized.includes("data->>'thumbnail' = ?")) {
      assert.equal(String(values[0]), OWNER_PROJECT_ID)
      return []
    }

    if (normalized.startsWith('delete from generation_history where id = ? and project_id = ?')) {
      deleteRowCalled = true
      assert.equal(String(values[0]), 'owned-asset')
      assert.equal(String(values[1]), OWNER_PROJECT_ID)
      return []
    }

    throw new Error(`Unhandled SQL in assets/[assetId] test: ${normalized}`)
  }

  const handlers = createAssetRouteHandlers({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getR2Client: () => ({
      send: async (command: { input?: { Key?: string } }) => {
        r2Deletes.push(String(command.input?.Key))
      },
    }) as any,
  })

  const missingResponse = await handlers.DELETE(
    makeRequest('http://spite.local/api/assets/missing', { method: 'DELETE' }) as any,
    { params: Promise.resolve({ assetId: 'missing' }) } as any,
  )
  assert.equal(missingResponse.status, 404)
  assert.equal(deleteRowCalled, false)
  assert.deepEqual(r2Deletes, [])

  const ownedResponse = await handlers.DELETE(
    makeRequest('http://spite.local/api/assets/owned-asset', { method: 'DELETE' }) as any,
    { params: Promise.resolve({ assetId: 'owned-asset' }) } as any,
  )
  assert.equal(ownedResponse.status, 200)
  assert.equal(sawProjectionLagCheck, true)
  assert.equal(deleteRowCalled, true)
  assert.equal(emptyFolderDeleted, true)
  assert.deepEqual(r2Deletes, ['uploads/owned.png'])
})

test('asset canonicalization verifies an owned main-app image before replacing its URL', async () => {
  const canonical = '/api/assets/550e8400-e29b-41d4-a716-446655440010/download?workspace_id=550e8400-e29b-41d4-a716-446655440020'
  let storedUrl = ''
  let fetchCalls = 0
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('from generation_history g join projects p on p.id::text = g.project_id')) {
      return [{ id: 'owned-asset', project_id: OWNER_PROJECT_ID, r2_url: '/api/r2-image/old.png' }]
    }
    if (normalized.startsWith('update generation_history set r2_url = ?')) {
      storedUrl = String(values[0])
      assert.equal(String(values[1]), 'owned-asset')
      assert.equal(String(values[2]), OWNER_PROJECT_ID)
      return []
    }
    throw new Error(`Unhandled SQL in canonical asset test: ${normalized}`)
  }
  const handlers = createAssetRouteHandlers({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    env: { NEXOCLIP_INTERNAL_URL: 'http://main.internal' },
    fetchFn: async (url, init) => {
      fetchCalls += 1
      assert.equal(String(url), `http://main.internal${canonical}`)
      assert.equal(new Headers(init?.headers).get('cookie'), 'nexoclip_session=secret')
      return new Response('image', { headers: { 'content-type': 'image/png' } })
    },
  })

  const invalid = await handlers.PATCH(
    makeRequest('http://spite.local/api/assets/owned-asset', { method: 'PATCH', body: { canonical_url: 'https://evil.test/image.png' } }) as any,
    { params: Promise.resolve({ assetId: 'owned-asset' }) } as any,
  )
  assert.equal(invalid.status, 400)
  assert.equal(fetchCalls, 0)

  const response = await handlers.PATCH(
    makeRequest('http://spite.local/api/assets/owned-asset', {
      method: 'PATCH',
      body: { canonical_url: canonical },
      headers: { cookie: 'nexoclip_session=secret' },
    }) as any,
    { params: Promise.resolve({ assetId: 'owned-asset' }) } as any,
  )
  assert.equal(response.status, 200)
  assert.equal(fetchCalls, 1)
  assert.equal(storedUrl, canonical)
})

test('assets/by-url requires projectId and scopes lookup/update to owned projects', async () => {
  let updatedRows = 0
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
      return String(values[0]) === OWNER_PROJECT_ID && String(values[1]) === OWNER_ID ? [{ ok: 1 }] : []
    }

    if (normalized.startsWith('select id from generation_history where project_id = ? and r2_url = ? order by created_at desc limit 1')) {
      assert.equal(String(values[0]), OWNER_PROJECT_ID)
      return [{ id: 'asset-1' }]
    }

    if (normalized.includes('update generation_history set used_in_canvas = ?') && normalized.includes('expires_at = ?') && normalized.includes('where project_id = ? and r2_url = ? returning id')) {
      assert.equal(String(values[2]), OWNER_PROJECT_ID)
      updatedRows += 1
      return [{ id: 'asset-1' }]
    }

    throw new Error(`Unhandled SQL in assets/by-url test: ${normalized}`)
  }

  const handlers = createAssetByUrlRouteHandlers({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    assetExpiresAt: async () => null,
  })

  const missingProject = await handlers.GET(makeRequest('http://spite.local/api/assets/by-url?url=https://cdn.example/uploads/a.png') as any)
  assert.equal(missingProject.status, 400)

  const foreignProject = await handlers.GET(makeRequest(`http://spite.local/api/assets/by-url?projectId=${OTHER_PROJECT_ID}&url=https://cdn.example/uploads/a.png`) as any)
  assert.equal(foreignProject.status, 404)

  const ownedGet = await handlers.GET(makeRequest(`http://spite.local/api/assets/by-url?projectId=${OWNER_PROJECT_ID}&url=https://cdn.example/uploads/a.png`) as any)
  assert.deepEqual(await ownedGet.json(), { id: 'asset-1' })

  const ownedPost = await handlers.POST(makeRequest('http://spite.local/api/assets/by-url', {
    method: 'POST',
    body: {
      projectId: OWNER_PROJECT_ID,
      url: 'https://cdn.example/uploads/a.png',
      used_in_canvas: false,
    },
  }) as any)
  assert.equal(ownedPost.status, 200)
  assert.equal(updatedRows, 1)
})

test('project assets/upload DELETE uses stored owned key and ignores caller filename', async () => {
  const deletedKeys: string[] = []

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
      return [{ ok: 1 }]
    }

    if (normalized.startsWith('select id, projectid, url, metadata from assets where id = ? and projectid = ? limit 1')) {
      return [{
        id: 'asset-1',
        projectid: OWNER_PROJECT_ID,
        url: '/api/r2-image/owner/real-file.png',
        metadata: { filename: 'owner/real-file.png' },
      }]
    }

    if (normalized.startsWith('delete from assets where id = ? and projectid = ?')) {
      return []
    }

    throw new Error(`Unhandled SQL in project asset upload delete test: ${normalized}`)
  }

  const handlers = createProjectAssetUploadHandlers({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    getR2Client: () => ({
      send: async (command: { input?: { Key?: string } }) => {
        deletedKeys.push(String(command.input?.Key))
      },
    }) as any,
  })

  const response = await handlers.DELETE(makeRequest(`http://spite.local/api/projects/${OWNER_PROJECT_ID}/assets/upload`, {
    method: 'DELETE',
    body: {
      assetId: 'asset-1',
      filename: 'attacker/chosen-key.png',
    },
  }) as any, { params: Promise.resolve({ projectId: OWNER_PROJECT_ID }) } as any)

  assert.equal(response.status, 200)
  assert.deepEqual(deletedKeys, ['owner/real-file.png'])
})

test('folders reject foreign asset ids atomically on create and replace', async () => {
  let folderInserted = false
  let folderMembershipDeleted = false
  let folderMembershipInserted = false

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

    if (
      normalized.startsWith('drop table if exists asset_folder_items cascade') ||
      normalized.startsWith('drop table if exists asset_folders cascade') ||
      normalized.startsWith('create table asset_folders') ||
      normalized.startsWith('create index idx_asset_folders_project on asset_folders') ||
      normalized.startsWith('create table asset_folder_items') ||
      normalized.startsWith('create index idx_asset_folder_items_asset on asset_folder_items') ||
      normalized.startsWith('alter table asset_folder_items add column if not exists workspace_asset_id') ||
      normalized.startsWith('create index if not exists idx_folder_items_workspace_asset')
    ) {
      return []
    }

    if (normalized.includes("from information_schema.columns") && normalized.includes("where table_name = 'asset_folders'")) {
      return [{ data_type: 'text' }]
    }

    if (normalized.includes("from information_schema.table_constraints tc") && normalized.includes("where tc.table_name = 'asset_folder_items'")) {
      return [{ ok: 1 }]
    }

    if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
      return [{ ok: 1 }]
    }

    if (normalized.includes('select count(*)::int as owned_count from generation_history g join projects p on p.id::text = g.project_id::text') && normalized.includes('g.id::text = any(')) {
      return [{ owned_count: 1 }]
    }

    if (normalized.startsWith('insert into asset_folders')) {
      folderInserted = true
      return []
    }

    if (normalized.startsWith('select 1 from asset_folders f join projects p on p.id::text = f.project_id::text where f.id::text = ? and p.userid = ? limit 1')) {
      return [{ ok: 1 }]
    }

    if (normalized.startsWith('select project_id from asset_folders where id = ? limit 1')) {
      return [{ project_id: OWNER_PROJECT_ID }]
    }

    if (normalized.startsWith('delete from asset_folder_items where folder_id = ?')) {
      folderMembershipDeleted = true
      return []
    }

    if (normalized.startsWith('insert into asset_folder_items')) {
      folderMembershipInserted = true
      return []
    }

    throw new Error(`Unhandled SQL in folders atomic validation test: ${normalized}`)
  }

  const folders = createFoldersRouteHandlers({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    createFolderId: () => 'folder-1',
  })
  const folder = createFolderRouteHandlers({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
  })

  const createResponse = await folders.POST(makeRequest('http://spite.local/api/folders', {
    method: 'POST',
    body: {
      name: 'Refs',
      type: 'character',
      projectId: OWNER_PROJECT_ID,
      assetIds: ['owned-asset', 'foreign-asset'],
    },
  }) as any)
  assert.equal(createResponse.status, 404)
  assert.equal(folderInserted, false)

  const patchResponse = await folder.PATCH(makeRequest('http://spite.local/api/folders/folder-1', {
    method: 'PATCH',
    body: {
      setAssetIds: ['owned-asset', 'foreign-asset'],
    },
  }) as any, { params: Promise.resolve({ folderId: 'folder-1' }) } as any)
  assert.equal(patchResponse.status, 404)
  assert.equal(folderMembershipDeleted, false)
  assert.equal(folderMembershipInserted, false)
})

test('generate/recover cleanup scopes pending marker removal by authorized projectId', async () => {
  const cleanupCalls: Array<{ projectId: string; nodeId: string }> = []

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('select 1 from projects where id = ? and userid = ? limit 1')) {
      return [{ ok: 1 }]
    }

    if (normalized.includes('select projectid, nodeid, data, type from canvas_nodes where projectid = ?') && normalized.includes("data->>'pendingrequestid' is not null") && normalized.includes("data->>'pendingfalendpoint' is not null")) {
      return [{
        projectid: OWNER_PROJECT_ID,
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
      return [{ project_id: OWNER_PROJECT_ID, durable_seq: 1, projected_seq: 1 }]
    }

    throw new Error(`Unhandled SQL in recover cleanup test: ${normalized}`)
  }

  const handler = createGenerateRecoverHandler({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    falKey: 'test-fal-key',
    fetchFalStatus: async () => Response.json({ status: 'FAILED' }),
    fetchFalResult: async () => Response.json({}),
    createInternalRealtimeClient: () => ({
      patchNodeData: async ({ projectId, nodeId }: { projectId: string; nodeId: string }) => {
        cleanupCalls.push({ projectId, nodeId })
      },
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/recover', {
    method: 'POST',
    body: { projectId: OWNER_PROJECT_ID },
  }) as any)

  assert.equal(response.status, 200)
  assert.deepEqual(cleanupCalls, [{ projectId: OWNER_PROJECT_ID, nodeId: 'node-1' }])
})

test('generate/recover bulk cleanup uses projectId+nodeId pair when node ids repeat across owned projects', async () => {
  const secondProjectId = '550e8400-e29b-41d4-a716-4466554400aa'
  const cleanupCalls: Array<{ projectId: string; nodeId: string }> = []

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const normalized = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('select c.projectid, c.nodeid, c.data, c.type from canvas_nodes c join projects p on p.id::text = c.projectid') && normalized.includes('where p.userid = ?') && normalized.includes("c.data->>'pendingrequestid' is not null") && normalized.includes("c.data->>'pendingfalendpoint' is not null")) {
      return [
        {
          projectid: OWNER_PROJECT_ID,
          nodeid: 'shared-node',
          type: 'imageGen',
          data: {
            pendingRequestId: 'req-owner-failed',
            pendingFalEndpoint: 'fal-ai/flux/dev',
            prompt: 'owner node',
          },
        },
        {
          projectid: secondProjectId,
          nodeid: 'shared-node',
          type: 'imageGen',
          data: {
            pendingRequestId: 'req-second-pending',
            pendingFalEndpoint: 'fal-ai/flux/dev',
            prompt: 'second node',
          },
        },
      ]
    }

    if (normalized.includes('select p.id as project_id, d.durable_seq, d.projected_seq from projects p left join canvas_yjs_documents d on d.project_id = p.id::text') && normalized.includes('where p.userid = ?')) {
      return [
        { project_id: OWNER_PROJECT_ID, durable_seq: 1, projected_seq: 1 },
        { project_id: secondProjectId, durable_seq: 1, projected_seq: 1 },
      ]
    }

    throw new Error(`Unhandled SQL in repeated nodeId cleanup test: ${normalized}`)
  }

  const handler = createGenerateRecoverHandler({
    getDb: () => sql as any,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    falKey: 'test-fal-key',
    fetchFalStatus: async (requestId) => {
      if (requestId === 'req-owner-failed') return Response.json({ status: 'FAILED' })
      if (requestId === 'req-second-pending') return Response.json({ status: 'IN_PROGRESS' })
      throw new Error(`unexpected requestId: ${requestId}`)
    },
    fetchFalResult: async () => Response.json({}),
    createInternalRealtimeClient: () => ({
      patchNodeData: async ({ projectId, nodeId }: { projectId: string; nodeId: string }) => {
        cleanupCalls.push({ projectId, nodeId })
      },
    }) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/recover', {
    method: 'POST',
    body: {},
  }) as any)

  assert.equal(response.status, 200)
  assert.deepEqual(cleanupCalls, [{ projectId: OWNER_PROJECT_ID, nodeId: 'shared-node' }])
})

test('auth/check: trusted main session -> 200/authenticated true; legacy spite-only session -> 401/authenticated false', async () => {
  const trusted = createAuthCheckHandler({
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
  })
  const legacy = createAuthCheckHandler({
    getAuthenticatedUser: async () => null,
  })

  const trustedResponse = await trusted(makeRequest('http://spite.local/api/auth/check', {
    headers: { cookie: 'nexoclip_session=main-session' },
  }) as any)
  const legacyResponse = await legacy(makeRequest('http://spite.local/api/auth/check', {
    headers: { cookie: 'spite_session=legacy-session' },
  }) as any)

  assert.equal(trustedResponse.status, 200)
  assert.deepEqual(await trustedResponse.json(), { authenticated: true })
  assert.equal(legacyResponse.status, 401)
  assert.deepEqual(await legacyResponse.json(), { authenticated: false })
})
