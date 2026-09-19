import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { ensureFoldersSchema } from '@/lib/folders-schema'
import { getAuthenticatedUser } from '@/lib/main-session'
import {
  assetNotFoundResponse,
  countOwnedGenerationAssetsForProject,
  deleteEmptyAssetFolders,
  folderNotFoundResponse,
  unauthorizedResponse,
  userOwnsFolder,
} from '@/lib/project-ownership'

interface FolderRouteDeps {
  getDb?: typeof getDb
  getAuthenticatedUser?: typeof getAuthenticatedUser
}

function normalizeAssetIds(assetIds: unknown): string[] {
  if (!Array.isArray(assetIds)) return []
  return [...new Set(assetIds.filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0))]
}

export function createFolderRouteHandlers(deps: FolderRouteDeps = {}) {
  const db = deps.getDb ?? getDb
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser

  return {
    async GET(
      request: Request,
      { params }: { params: Promise<{ folderId: string }> },
    ) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        await ensureFoldersSchema(sql)
        const { folderId } = await params
        if (!(await userOwnsFolder(sql, user.id, folderId))) {
          return folderNotFoundResponse()
        }

        const folders = await sql`
          SELECT id, project_id, type, name, description, created_at, updated_at
          FROM asset_folders
          WHERE id = ${folderId}
        `
        if (folders.length === 0) {
          return folderNotFoundResponse()
        }

        const items = await sql`
          SELECT i.asset_id, i.workspace_asset_id, g.r2_url, g.type AS asset_type, g.prompt
          FROM asset_folder_items i
          LEFT JOIN generation_history g ON g.id = i.asset_id
          WHERE i.folder_id = ${folderId}
          ORDER BY i.added_at DESC
        `

        return NextResponse.json({
          ...folders[0],
          assets: items.map(r => ({
            id: r.asset_id,
            workspaceAssetId: r.workspace_asset_id ?? undefined,
            r2_url: r.r2_url,
            type: r.asset_type,
            prompt: r.prompt,
          })),
        })
      } catch (err: any) {
        console.error('[folders] GET single error:', err)
        return NextResponse.json(
          { error: 'Failed to fetch folder' },
          { status: 500 },
        )
      }
    },

    async PATCH(
      request: Request,
      { params }: { params: Promise<{ folderId: string }> },
    ) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        await ensureFoldersSchema(sql)
        const { folderId } = await params
        if (!(await userOwnsFolder(sql, user.id, folderId))) {
          return folderNotFoundResponse()
        }

        const { name, description, addAssetIds, removeAssetIds, setAssetIds, workspaceAssetIds = {} } = await request.json()

        const folders = await sql`
          SELECT project_id FROM asset_folders WHERE id = ${folderId} LIMIT 1
        ` as Array<{ project_id: string }>
        const projectId = folders[0]?.project_id
        if (!projectId) {
          return folderNotFoundResponse()
        }

        if (name !== undefined || description !== undefined) {
          await sql`
            UPDATE asset_folders
            SET
              name = COALESCE(${name ?? null}, name),
              description = COALESCE(${description ?? null}, description),
              updated_at = now()
            WHERE id = ${folderId}
          `
        }

        const normalizedSetAssetIds = normalizeAssetIds(setAssetIds)
        if (
          normalizedSetAssetIds.length > 0 &&
          (await countOwnedGenerationAssetsForProject(sql, user.id, projectId, normalizedSetAssetIds)) !== normalizedSetAssetIds.length
        ) {
          return assetNotFoundResponse()
        }

        const normalizedAddAssetIds = normalizeAssetIds(addAssetIds)
        if (
          normalizedAddAssetIds.length > 0 &&
          (await countOwnedGenerationAssetsForProject(sql, user.id, projectId, normalizedAddAssetIds)) !== normalizedAddAssetIds.length
        ) {
          return assetNotFoundResponse()
        }

        if (Array.isArray(setAssetIds)) {
          await sql`DELETE FROM asset_folder_items WHERE folder_id = ${folderId}`
          for (const assetId of normalizedSetAssetIds) {
            if (!assetId) continue
            await sql`
              INSERT INTO asset_folder_items (folder_id, asset_id, workspace_asset_id)
              VALUES (${folderId}, ${assetId}, ${typeof workspaceAssetIds[assetId] === 'string' ? workspaceAssetIds[assetId] : null})
              ON CONFLICT (folder_id, asset_id) DO UPDATE
              SET workspace_asset_id = COALESCE(EXCLUDED.workspace_asset_id, asset_folder_items.workspace_asset_id)
            `
            await sql`
              UPDATE generation_history
              SET used_in_canvas = true, expires_at = NULL
              WHERE id = ${assetId}
            `
          }
        } else {
          if (Array.isArray(addAssetIds)) {
            for (const assetId of normalizedAddAssetIds) {
              if (!assetId) continue
              await sql`
                INSERT INTO asset_folder_items (folder_id, asset_id, workspace_asset_id)
                VALUES (${folderId}, ${assetId}, ${typeof workspaceAssetIds[assetId] === 'string' ? workspaceAssetIds[assetId] : null})
                ON CONFLICT (folder_id, asset_id) DO UPDATE
                SET workspace_asset_id = COALESCE(EXCLUDED.workspace_asset_id, asset_folder_items.workspace_asset_id)
              `
              await sql`
                UPDATE generation_history
                SET used_in_canvas = true, expires_at = NULL
                WHERE id = ${assetId}
              `
            }
          }
          if (Array.isArray(removeAssetIds) && removeAssetIds.length > 0) {
            await sql`
              DELETE FROM asset_folder_items
              WHERE folder_id = ${folderId}
                AND asset_id = ANY(${removeAssetIds}::text[])
            `
          }
        }

        const shouldDeleteIfEmpty = Array.isArray(setAssetIds)
          || (Array.isArray(removeAssetIds) && removeAssetIds.length > 0)
        const deleted = shouldDeleteIfEmpty
          ? await deleteEmptyAssetFolders(sql, [folderId]) > 0
          : false

        return NextResponse.json({ success: true, deleted })
      } catch (err: any) {
        console.error('[folders] PATCH error:', err)
        return NextResponse.json(
          { error: 'Failed to update folder' },
          { status: 500 },
        )
      }
    },

    async DELETE(
      request: Request,
      { params }: { params: Promise<{ folderId: string }> },
    ) {
      try {
        const user = await resolveUser(request)
        if (!user) return unauthorizedResponse()

        const sql = db()
        await ensureFoldersSchema(sql)
        const { folderId } = await params
        if (!(await userOwnsFolder(sql, user.id, folderId))) {
          return folderNotFoundResponse()
        }

        await sql`DELETE FROM asset_folders WHERE id::text = ${folderId}`
        return NextResponse.json({ success: true })
      } catch (err: any) {
        console.error('[folders] DELETE error:', err)
        return NextResponse.json(
          { error: 'Failed to delete folder' },
          { status: 500 },
        )
      }
    },
  }
}

const handlers = createFolderRouteHandlers()

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ folderId: string }> },
) {
  return handlers.GET(request, context)
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ folderId: string }> },
) {
  return handlers.PATCH(request, context)
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ folderId: string }> },
) {
  return handlers.DELETE(request, context)
}
