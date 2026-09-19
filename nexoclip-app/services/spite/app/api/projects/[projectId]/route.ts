import { getDb } from '@/lib/db'
import { getR2Client } from '@/lib/r2-upload'
import { getAuthenticatedUser } from '@/lib/main-session'
import {
  projectNotFoundResponse,
  unauthorizedResponse,
  userOwnsProject,
} from '@/lib/project-ownership'
import {
  createInternalRealtimeClient,
  projectionHasMediaReference,
  type InternalRealtimeClient,
} from '@/lib/realtime/internal-client'
import { NextRequest, NextResponse } from 'next/server'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

// Extract the R2 object key from a stored asset URL. Mirrors the logic in
// app/api/assets/cleanup so we delete consistently across cleanup paths.
function keyFromUrl(url: string): string | null {
  const proxy = url.match(/\/api\/r2-image\/(.+)$/)
  if (proxy) return proxy[1]
  const uploads = url.match(/\/uploads\/[^/]+$/)
  if (uploads) return uploads[0].slice(1)
  return null
}

async function deleteR2Key(key: string) {
  try {
    const client = getR2Client()
    await client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
    }))
  } catch (err) {
    console.error('[projects] R2 delete failed for', key, err)
  }
}

interface ProjectRouteDeps {
  getDb?: typeof getDb
  getAuthenticatedUser?: typeof getAuthenticatedUser
  createInternalRealtimeClient?: () => InternalRealtimeClient
}

async function loadLaggingAuthoritativeReferrers({
  sql,
  userId,
  projectId,
  urls,
  client,
}: {
  sql: ReturnType<typeof getDb>
  userId: string
  projectId: string
  urls: string[]
  client: InternalRealtimeClient
}): Promise<Map<string, string>> {
  const matches = new Map<string, string>()
  if (urls.length === 0) {
    return matches
  }

  const laggingProjects = await sql`
    SELECT d.project_id
    FROM canvas_yjs_documents d
    JOIN projects p ON p.id::text = d.project_id::text
    WHERE p.userid = ${userId}
      AND d.project_id::text <> ${projectId}::text
      AND d.projected_seq < d.durable_seq
  ` as Array<{ project_id: string }>

  for (const row of laggingProjects) {
    const authoritative = await client.exportDocument({
      userId,
      projectId: row.project_id,
    })

    for (const url of urls) {
      if (!matches.has(url) && projectionHasMediaReference(authoritative.projection, { url })) {
        matches.set(url, row.project_id)
      }
    }
  }

  return matches
}

export function createProjectRouteHandlers(deps: ProjectRouteDeps = {}) {
  const db = deps.getDb ?? getDb
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser
  const internalRealtime = deps.createInternalRealtimeClient ?? createInternalRealtimeClient

  return {
    async GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        const { projectId } = await params
        if (!(await userOwnsProject(sql, user.id, projectId))) {
          return projectNotFoundResponse()
        }

        const result = await sql`
          SELECT id, name, description, thumbnail, createdAt, updatedAt
          FROM projects
          WHERE id = ${projectId}
        `

        if (result.length === 0) {
          return projectNotFoundResponse()
        }

        return NextResponse.json(result[0])
      } catch (error) {
        console.error('Error fetching project:', error)
        return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 })
      }
    },

    async PUT(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        const { projectId } = await params
        if (!(await userOwnsProject(sql, user.id, projectId))) {
          return projectNotFoundResponse()
        }

        const { name, description, thumbnail } = await request.json()
        const result = await sql`
          UPDATE projects
          SET name = ${name}, description = ${description || ''}, thumbnail = ${thumbnail || null}, updatedAt = NOW()
          WHERE id = ${projectId}
          RETURNING id, name, description, thumbnail, createdAt, updatedAt
        `

        if (result.length === 0) {
          return projectNotFoundResponse()
        }

        return NextResponse.json(result[0])
      } catch (error) {
        console.error('Error updating project:', error)
        return NextResponse.json({ error: 'Failed to update project' }, { status: 500 })
      }
    },

    async DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        const { projectId } = await params
        if (!(await userOwnsProject(sql, user.id, projectId))) {
          return projectNotFoundResponse()
        }

        // For each asset whose generation_history row points at this project,
        // decide whether to hard-delete it or to reassign its ownership to
        // another project that still references the same r2_url. This way
        // duplicates (which share r2_urls with their source project) never
        // lose their media when the source project is deleted.
        const assets = await sql`
          SELECT id, r2_url
          FROM generation_history
          WHERE project_id = ${projectId}
        ` as { id: string; r2_url: string | null }[]

        const uploadRows = await sql`
          SELECT id, url FROM assets WHERE projectid = ${projectId}
        ` as { id: string; url: string | null }[]
        const candidateUrls = Array.from(new Set([
          ...assets.map((asset) => asset.r2_url).filter((value): value is string => !!value),
          ...uploadRows.map((row) => row.url).filter((value): value is string => !!value),
        ]))
        const laggingAuthoritativeReferrers = await loadLaggingAuthoritativeReferrers({
          sql,
          userId: user.id,
          projectId,
          urls: candidateUrls,
          client: internalRealtime(),
        })

        const exclusiveAssetIds: string[] = []
        const exclusiveKeys: string[] = []

        for (const asset of assets) {
          const url = asset.r2_url
          if (!url) {
            exclusiveAssetIds.push(asset.id)
            continue
          }
          const referrer = await sql`
            SELECT projectid
            FROM canvas_nodes
            WHERE projectid <> ${projectId}::text
              AND (data->>'outputUrl' = ${url} OR data->>'thumbnail' = ${url})
            LIMIT 1
          ` as { projectid: string }[]
          const resolvedReferrer = referrer[0]?.projectid ?? laggingAuthoritativeReferrers.get(url) ?? null

          if (!resolvedReferrer) {
            const key = keyFromUrl(url)
            if (key) exclusiveKeys.push(key)
            exclusiveAssetIds.push(asset.id)
          } else {
            await sql`
              UPDATE generation_history
              SET project_id = ${resolvedReferrer}
              WHERE id = ${asset.id}
            `
          }
        }

        // Delete the R2 objects for exclusive assets in parallel; errors are
        // logged but never block the DB cleanup (orphan files are reaped by
        // the cleanup cron eventually).
        await Promise.all(exclusiveKeys.map(deleteR2Key))

        if (exclusiveAssetIds.length) {
          await sql`
            DELETE FROM generation_history
            WHERE id = ANY(${exclusiveAssetIds}::text[])
          `
        }

        // Toolbar uploads live in the `assets` table, not generation_history, and
        // used to leak: project-delete dropped only their DB rows while the R2
        // objects lingered forever (the cleanup cron never scans `assets`). Delete
        // each file too — unless another project's canvas still references the same
        // r2_url (a duplicate shares it via copied canvas_nodes), in which case the
        // file must stay. Mirrors the generation_history exclusivity check above.
        const uploadKeys: string[] = []
        for (const row of uploadRows) {
          const url = row.url
          if (!url) continue
          const referrer = await sql`
            SELECT projectid
            FROM canvas_nodes
            WHERE projectid <> ${projectId}::text
              AND (data->>'outputUrl' = ${url} OR data->>'thumbnail' = ${url})
            LIMIT 1
          ` as { projectid: string }[]
          const resolvedReferrer = referrer[0]?.projectid ?? laggingAuthoritativeReferrers.get(url) ?? null
          if (!resolvedReferrer) {
            const key = keyFromUrl(url)
            if (key) uploadKeys.push(key)
          }
        }
        await Promise.all(uploadKeys.map(deleteR2Key))

        // Tear down the canvas tables explicitly — they don't have ON DELETE
        // CASCADE on the project FK, and asset_folders/items keyed by
        // project_id should go with the project too.
        await sql`DELETE FROM asset_folder_items WHERE folder_id IN (SELECT id FROM asset_folders WHERE project_id = ${projectId})`
        await sql`DELETE FROM asset_folders WHERE project_id = ${projectId}`
        await sql`DELETE FROM assets WHERE projectid = ${projectId}`
        await sql`DELETE FROM canvas_edges WHERE projectid = ${projectId}::text`
        await sql`DELETE FROM canvas_nodes WHERE projectid = ${projectId}::text`
        await sql`DELETE FROM projects WHERE id = ${projectId}`

        return NextResponse.json({
          success: true,
          assetsDeleted: exclusiveAssetIds.length,
          assetsTransferred: assets.length - exclusiveAssetIds.length,
          uploadFilesDeleted: uploadKeys.length,
        })
      } catch (error) {
        console.error('Error deleting project:', error)
        return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 })
      }
    },
  }
}

const handlers = createProjectRouteHandlers()

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  return handlers.GET(request, context)
}

export async function PUT(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  return handlers.PUT(request, context)
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  return handlers.DELETE(request, context)
}
