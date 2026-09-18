import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/db'
import { getAuthenticatedUser } from '@/lib/main-session'
import {
  assetNotFoundResponse,
  deleteEmptyAssetFolders,
  findOwnedGenerationAsset,
  unauthorizedResponse,
  userOwnsProject,
} from '@/lib/project-ownership'
import {
  createInternalRealtimeClient,
  projectionHasMediaReference,
  type InternalRealtimeClient,
} from '@/lib/realtime/internal-client'
import { getR2Client } from '@/lib/r2-upload'
import { workspaceAssetReferencePatches } from '@/lib/workspace-asset-delete'

function assetKeyFromUrl(url: string | null): string | null {
  if (!url) return null

  const proxyMatch = url.match(/\/api\/r2-image\/(.+)$/)
  if (proxyMatch) return proxyMatch[1] ?? null

  const uploadsMatch = url.match(/\/uploads\/[^/?#]+$/)
  if (uploadsMatch) return uploadsMatch[0].slice(1)

  return null
}

interface AssetRouteDeps {
  getDb?: typeof getDb
  getAuthenticatedUser?: typeof getAuthenticatedUser
  getR2Client?: typeof getR2Client
  createInternalRealtimeClient?: () => InternalRealtimeClient
  fetchFn?: typeof fetch
  env?: Partial<Pick<NodeJS.ProcessEnv, 'NEXOCLIP_INTERNAL_URL'>>
}

export function createAssetRouteHandlers(deps: AssetRouteDeps = {}) {
  const db = deps.getDb ?? getDb
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser
  const r2Client = deps.getR2Client ?? getR2Client
  const internalRealtime = deps.createInternalRealtimeClient ?? createInternalRealtimeClient
  const fetchFn = deps.fetchFn ?? fetch
  const env = deps.env ?? process.env

  return {
    async GET(
      request: Request,
      { params }: { params: Promise<{ assetId: string }> },
    ) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        const { assetId } = await params
        const asset = await findOwnedGenerationAsset(sql, user.id, assetId)
        if (!asset) return assetNotFoundResponse()

        return NextResponse.json(asset)
      } catch (error) {
        console.error('[assets] Fetch error:', error)
        return NextResponse.json({ error: 'Failed to fetch asset' }, { status: 500 })
      }
    },

    async PATCH(
      request: Request,
      { params }: { params: Promise<{ assetId: string }> },
    ) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        const { assetId } = await params
        const asset = await findOwnedGenerationAsset(sql, user.id, assetId)
        if (!asset) return assetNotFoundResponse()

        const body = await request.json()
        const { used_in_canvas, recovered, canonical_url } = body as {
          used_in_canvas?: boolean
          recovered?: boolean
          canonical_url?: string
        }

        if (used_in_canvas !== undefined) {
          const isProtected = used_in_canvas ?? true
          const expiresAt = isProtected ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          await sql`
            UPDATE generation_history
            SET used_in_canvas = ${isProtected}, expires_at = ${expiresAt}
            WHERE id = ${assetId} AND project_id = ${asset.project_id}
          `
        }

        if (recovered !== undefined) {
          await sql`ALTER TABLE generation_history ADD COLUMN IF NOT EXISTS recovered boolean DEFAULT false`
          await sql`
            UPDATE generation_history
            SET recovered = ${recovered}
            WHERE id = ${assetId} AND project_id = ${asset.project_id}
          `
        }

        if (canonical_url !== undefined) {
          const parsed = new URL(canonical_url, 'https://canvas.invalid')
          const canonicalPath = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/i.test(parsed.pathname)
          const baseUrl = env.NEXOCLIP_INTERNAL_URL?.trim().replace(/\/$/, '')
          if (!canonicalPath || !baseUrl) {
            return NextResponse.json({ error: 'Invalid workspace asset URL' }, { status: 400 })
          }
          const upstream = await fetchFn(`${baseUrl}${parsed.pathname}${parsed.search}`, {
            headers: { cookie: request.headers.get('cookie') ?? '' },
          })
          const isOwnedImage = upstream.ok && upstream.headers.get('content-type')?.startsWith('image/')
          await upstream.body?.cancel()
          if (!isOwnedImage) {
            return NextResponse.json({ error: 'Workspace image not found' }, { status: 404 })
          }
          const storedUrl = `${parsed.pathname}${parsed.search}`
          await sql`
            UPDATE generation_history
            SET r2_url = ${storedUrl}
            WHERE id = ${assetId} AND project_id = ${asset.project_id}
          `
        }

        return NextResponse.json({ success: true })
      } catch (error) {
        console.error('[assets] Update error:', error)
        return NextResponse.json({ error: 'Failed to update asset' }, { status: 500 })
      }
    },

    async DELETE(
      request: Request,
      { params }: { params: Promise<{ assetId: string }> },
    ) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        const { assetId } = await params
        const asset = await findOwnedGenerationAsset(sql, user.id, assetId)
        if (!asset) {
          const projectId = new URL(request.url).searchParams.get('projectId')
          if (!projectId || !(await userOwnsProject(sql, user.id, projectId))) return assetNotFoundResponse()

          const ownedProjects = await sql`
            SELECT id::text AS id FROM projects WHERE userid = ${user.id}
          ` as Array<{ id: string }>
          const realtime = internalRealtime()
          for (const { id } of ownedProjects) {
            const { projection } = await realtime.exportDocument({ userId: user.id, projectId: id })
            for (const patch of workspaceAssetReferencePatches(projection, assetId)) {
              await realtime.patchNodeData({ userId: user.id, projectId: id, ...patch })
            }
          }

          const baseUrl = env.NEXOCLIP_INTERNAL_URL?.trim().replace(/\/$/, '')
          if (!baseUrl) return NextResponse.json({ error: 'Workspace asset service is unavailable' }, { status: 503 })
          const upstream = await fetchFn(`${baseUrl}/api/assets/${encodeURIComponent(assetId)}`, {
            method: 'DELETE',
            headers: { cookie: request.headers.get('cookie') ?? '' },
          })
          if (upstream.ok) {
            const removedRows = await sql`
              DELETE FROM asset_folder_items
              WHERE workspace_asset_id = ${assetId}
                AND folder_id IN (
                  SELECT f.id FROM asset_folders f
                  JOIN projects p ON p.id = f.project_id
                  WHERE p.userid = ${user.id}
                )
              RETURNING folder_id
            ` as Array<{ folder_id: string }>
            await deleteEmptyAssetFolders(sql, removedRows.map(row => row.folder_id))
          }
          return new NextResponse(await upstream.text(), {
            status: upstream.status,
            headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
          })
        }

        const removedRows = await sql`
          DELETE FROM asset_folder_items WHERE asset_id = ${assetId}
          RETURNING folder_id
        ` as { folder_id: string }[]
        const removedFromFolders = removedRows.length
        const deletedFolders = await deleteEmptyAssetFolders(sql, removedRows.map(row => row.folder_id))

        const projectionSequence = await sql`
          SELECT durable_seq, projected_seq
          FROM canvas_yjs_documents
          WHERE project_id = ${asset.project_id}
        ` as Array<{ durable_seq: number; projected_seq: number }>

        let assetStillReferenced = false
        const projectionIsCurrent = projectionSequence.length > 0
          && Number(projectionSequence[0].durable_seq) === Number(projectionSequence[0].projected_seq)

        if (projectionIsCurrent) {
          const canvasRefs = asset.r2_url
            ? await sql`
                SELECT 1 FROM canvas_nodes
                WHERE projectId = ${asset.project_id}
                  AND (
                    data->>'assetId' = ${assetId}
                    OR data->>'outputUrl' = ${asset.r2_url}
                    OR data->>'thumbnail' = ${asset.r2_url}
                  )
                LIMIT 1
              `
            : await sql`
                SELECT 1 FROM canvas_nodes
                WHERE projectId = ${asset.project_id}
                  AND data->>'assetId' = ${assetId}
                LIMIT 1
              `
          assetStillReferenced = canvasRefs.length > 0
        } else {
          const authoritative = await internalRealtime().exportDocument({
            userId: user.id,
            projectId: asset.project_id,
          })
          assetStillReferenced = projectionHasMediaReference(authoritative.projection, {
            assetId,
            url: asset.r2_url,
          })
        }

        if (assetStillReferenced) {
          await sql`
            UPDATE generation_history
            SET used_in_canvas = true, expires_at = NULL
            WHERE id = ${assetId} AND project_id = ${asset.project_id}
          `
          return NextResponse.json({
            success: true,
            kept: true,
            reason: 'still_on_canvas',
            removed_from_folders: removedFromFolders,
            deleted_folders: deletedFolders,
          })
        }

        await sql`DELETE FROM generation_history WHERE id = ${assetId} AND project_id = ${asset.project_id}`

        const key = assetKeyFromUrl(asset.r2_url)
        if (key) {
          try {
            await r2Client().send(
              new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME!,
                Key: key,
              })
            )
          } catch (r2Error) {
            console.error('[assets] R2 deletion failed:', r2Error)
          }
        }

        return NextResponse.json({
          success: true,
          kept: false,
          removed_from_folders: removedFromFolders,
          deleted_folders: deletedFolders,
        })
      } catch (error: any) {
        console.error('[assets] Delete error:', error)
        return NextResponse.json({ error: 'Failed to delete asset' }, { status: 500 })
      }
    },
  }
}

const handlers = createAssetRouteHandlers()

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return handlers.GET(request, context)
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return handlers.PATCH(request, context)
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return handlers.DELETE(request, context)
}
