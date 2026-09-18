import assert from 'node:assert/strict'
import test from 'node:test'

import { createProjectsRouteHandlers } from '@/app/api/projects/route'
import { createProjectRouteHandlers } from '@/app/api/projects/[projectId]/route'
import { createDuplicateProjectHandler } from '@/app/api/projects/[projectId]/duplicate/route'
import { createCanvasRouteHandlers } from '@/app/api/projects/[projectId]/canvas/route'
import { createProjectAssetsRouteHandlers } from '@/app/api/projects/[projectId]/assets/route'
import { createAssetsRouteHandlers } from '@/app/api/assets/route'
import { createFoldersRouteHandlers } from '@/app/api/folders/route'
import { createGenerateSubmitHandler } from '@/app/api/generate/submit/route'
import { createGenerateStatusHandler } from '@/app/api/generate/status/route'
import { createGenerateLatestHandler } from '@/app/api/generate/latest/route'
import { countOwnedGenerationAssetsForProject } from '@/lib/project-ownership'

const OWNER_ID = '550e8400-e29b-41d4-a716-446655440001'
const OTHER_USER_ID = '550e8400-e29b-41d4-a716-446655440002'
const OWNER_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440099'

test('compares text generation asset IDs to UUID project IDs safely', async () => {
  let query = ''
  const sql = (async (strings: TemplateStringsArray) => {
    query = strings.join(' ? ')
    return [{ owned_count: 1 }]
  }) as any

  assert.equal(await countOwnedGenerationAssetsForProject(sql, OWNER_ID, OWNER_PROJECT_ID, ['550e8400-e29b-41d4-a716-446655440010']), 1)
  assert.match(query, /p\.id::text = g\.project_id/)
  assert.match(query, /g\.project_id =\s+\?/)
  assert.match(query, /g\.id = ANY\(\s*\?\s+::text\[\]\)/)
})

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

type ProjectRecord = {
  id: string
  userid: string
  name: string
  description: string
  thumbnail: string | null
  origin: string
  createdat: string
  updatedat: string
}

type AssetRecord = {
  id: string
  project_id: string
  type: string
  model: string
  prompt: string
  r2_url: string
  used_in_canvas: boolean
  is_upload: boolean
  recovered: boolean
  refs: string[] | null
  created_at: string
}

function createFakeSqlFixture() {
  const projects = new Map<string, ProjectRecord>()
  const assets: AssetRecord[] = []

  const seedProject = (overrides: Partial<ProjectRecord> & Pick<ProjectRecord, 'id' | 'userid' | 'name'>) => {
    const project: ProjectRecord = {
      id: overrides.id,
      userid: overrides.userid,
      name: overrides.name,
      description: overrides.description ?? '',
      thumbnail: overrides.thumbnail ?? null,
      origin: overrides.origin ?? 'canvas',
      createdat: overrides.createdat ?? '2026-09-08T00:00:00.000Z',
      updatedat: overrides.updatedat ?? '2026-09-08T00:00:00.000Z',
    }
    projects.set(project.id, project)
    return project
  }

  const seedAsset = (record: AssetRecord) => {
    assets.push(record)
  }

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ? ')
    const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()

    if (
      normalized.startsWith('alter table projects add column if not exists origin') ||
      normalized.startsWith('alter table generation_history add column if not exists recovered') ||
      normalized.startsWith('alter table generation_history add column if not exists refs') ||
      normalized.startsWith('create index if not exists idx_genhistory_project_created on generation_history') ||
      normalized.startsWith('drop table if exists asset_folder_items cascade') ||
      normalized.startsWith('drop table if exists asset_folders cascade') ||
      normalized.startsWith('create table asset_folders') ||
      normalized.startsWith('create index idx_asset_folders_project on asset_folders') ||
      normalized.startsWith('create table asset_folder_items') ||
      normalized.startsWith('create index idx_asset_folder_items_asset on asset_folder_items') ||
      normalized.startsWith('alter table asset_folder_items add column if not exists workspace_asset_id') ||
      normalized.startsWith('create index if not exists idx_folder_items_workspace_asset') ||
      normalized.startsWith('create index idx_folder_items_workspace_asset')
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
      const project = projects.get(String(values[0]))
      return project && project.userid === String(values[1]) ? [{ ok: 1 }] : []
    }

    if (normalized.startsWith('insert into projects')) {
      const project: ProjectRecord = {
        id: String(values[0]),
        userid: String(values[1]),
        name: String(values[2]),
        description: String(values[3] ?? ''),
        origin: String(values[4] ?? 'canvas'),
        thumbnail: null,
        createdat: '2026-09-08T00:00:00.000Z',
        updatedat: '2026-09-08T00:00:00.000Z',
      }
      projects.set(project.id, project)
      return [project]
    }

    if (normalized.includes('from projects p') && normalized.includes('where p.userid = ?')) {
      return [...projects.values()]
        .filter((project) => project.userid === String(values[0]))
        .map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          thumbnail: project.thumbnail,
          origin: project.origin,
          createdat: project.createdat,
          updatedat: project.updatedat,
        }))
    }

    if (normalized.startsWith('select g.id, g.type, g.model, g.prompt, g.r2_url, g.used_in_canvas') && normalized.includes('from generation_history g join projects p on p.id::text = g.project_id')) {
      return assets
        .filter((asset) => projects.get(asset.project_id)?.userid === String(values[0]))
        .map((asset) => ({ ...asset }))
    }

    if (normalized.startsWith('select id, type, model, prompt, r2_url, used_in_canvas') && normalized.includes('from generation_history where project_id = ?')) {
      return assets
        .filter((asset) => asset.project_id === String(values[0]))
        .map((asset) => ({ ...asset }))
    }

    throw new Error(`Unhandled SQL in test: ${normalized}`)
  }

  return { sql: sql as any, seedProject, seedAsset, projects }
}

test('projects POST creates rows for the trusted user, not a browser-supplied userId', async () => {
  const fixture = createFakeSqlFixture()
  const handlers = createProjectsRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
    createProjectId: () => OWNER_PROJECT_ID,
  })

  const response = await handlers.POST(makeRequest('http://spite.local/api/projects', {
    method: 'POST',
    body: {
      name: 'Owned project',
      userId: OTHER_USER_ID,
    },
  }) as any)

  assert.equal(response.status, 200)
  assert.equal(fixture.projects.get(OWNER_PROJECT_ID)?.userid, OWNER_ID)
})

test('projects GET lists only the authenticated user\'s projects', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })
  fixture.seedProject({ id: OTHER_PROJECT_ID, userid: OTHER_USER_ID, name: 'Theirs' })

  const handlers = createProjectsRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
  })

  const response = await handlers.GET(makeRequest('http://spite.local/api/projects') as any)

  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).map((project: { id: string }) => project.id), [OWNER_PROJECT_ID])
})

test('project GET, PUT, and DELETE fail closed for non-owners', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })
  const handlers = createProjectRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
  })
  const params = Promise.resolve({ projectId: OWNER_PROJECT_ID })

  const getResponse = await handlers.GET(makeRequest('http://spite.local/api/projects/id') as any, { params } as any)
  const putResponse = await handlers.PUT(makeRequest('http://spite.local/api/projects/id', {
    method: 'PUT',
    body: { name: 'Nope' },
  }) as any, { params } as any)
  const deleteResponse = await handlers.DELETE(makeRequest('http://spite.local/api/projects/id', {
    method: 'DELETE',
  }) as any, { params } as any)

  assert.equal(getResponse.status, 404)
  assert.equal(putResponse.status, 404)
  assert.equal(deleteResponse.status, 404)
})

test('duplicate, canvas read, and project assets fail closed for non-owners', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })

  const duplicate = createDuplicateProjectHandler({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
  })
  const canvas = createCanvasRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
  })
  const projectAssets = createProjectAssetsRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
  })

  const params = Promise.resolve({ projectId: OWNER_PROJECT_ID })
  const duplicateResponse = await duplicate(makeRequest('http://spite.local/api/projects/id/duplicate', { method: 'POST' }) as any, { params } as any)
  const canvasResponse = await canvas.GET(makeRequest('http://spite.local/api/projects/id/canvas') as any, { params } as any)
  const projectAssetsResponse = await projectAssets.GET(makeRequest('http://spite.local/api/projects/id/assets') as any, { params } as any)

  assert.equal(duplicateResponse.status, 404)
  assert.equal(canvasResponse.status, 404)
  assert.equal(projectAssetsResponse.status, 404)
})

test('asset library view returns only assets from owned projects', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })
  fixture.seedProject({ id: OTHER_PROJECT_ID, userid: OTHER_USER_ID, name: 'Theirs' })
  fixture.seedAsset({
    id: 'asset-1',
    project_id: OWNER_PROJECT_ID,
    type: 'image',
    model: 'model-a',
    prompt: 'mine',
    r2_url: '/uploads/mine.png',
    used_in_canvas: true,
    is_upload: false,
    recovered: false,
    refs: null,
    created_at: '2026-09-08T00:00:00.000Z',
  })
  fixture.seedAsset({
    id: 'asset-2',
    project_id: OTHER_PROJECT_ID,
    type: 'image',
    model: 'model-b',
    prompt: 'theirs',
    r2_url: '/uploads/theirs.png',
    used_in_canvas: true,
    is_upload: false,
    recovered: false,
    refs: null,
    created_at: '2026-09-08T00:00:00.000Z',
  })

  const handlers = createAssetsRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OWNER_ID }),
  })

  const response = await handlers.GET(makeRequest('http://spite.local/api/assets') as any)

  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).map((asset: { id: string }) => asset.id), ['asset-1'])
})

test('folders fail closed for non-owners', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })

  const folders = createFoldersRouteHandlers({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
  })

  const response = await folders.GET(makeRequest(`http://spite.local/api/folders?projectId=${OWNER_PROJECT_ID}`) as any)

  assert.equal(response.status, 404)
})

test('generation submit rejects non-owner project mutations before provider work starts', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })
  let touchedProvider = false

  const handler = createGenerateSubmitHandler({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
    createNexoClipGenerationClient: (() => ({
      submit: async () => { touchedProvider = true; throw new Error('durable client must not be called') },
      status: async () => { touchedProvider = true; throw new Error('durable client must not be called') },
    })) as any,
  })

  const response = await handler(makeRequest('http://spite.local/api/generate/submit', {
    method: 'POST',
    body: {
      projectId: OWNER_PROJECT_ID,
      nodeId: 'node-1',
      kind: 'image',
      model: 'image-model',
      prompt: 'hello',
    },
  }) as any)

  assert.equal(response.status, 404)
  assert.equal(touchedProvider, false)
})

test('generation status and latest fail closed for non-owners before provider or db work', async () => {
  const fixture = createFakeSqlFixture()
  fixture.seedProject({ id: OWNER_PROJECT_ID, userid: OWNER_ID, name: 'Mine' })
  let touchedProvider = false

  const status = createGenerateStatusHandler({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
    createNexoClipGenerationClient: (() => ({
      submit: async () => { touchedProvider = true; throw new Error('durable client must not be called') },
      status: async () => { touchedProvider = true; throw new Error('durable client must not be called') },
    })) as any,
  })
  const latest = createGenerateLatestHandler({
    getDb: () => fixture.sql,
    getAuthenticatedUser: async () => ({ id: OTHER_USER_ID }),
  })

  const statusResponse = await status(makeRequest(`http://spite.local/api/generate/status?generationId=generation-1&nodeId=node-1&projectId=${OWNER_PROJECT_ID}`) as any)
  const latestResponse = await latest(makeRequest(`http://spite.local/api/generate/latest?projectId=${OWNER_PROJECT_ID}&type=image&prompt=hello&since=1`) as any)

  assert.equal(statusResponse.status, 404)
  assert.equal(latestResponse.status, 404)
  assert.equal(touchedProvider, false)
})
