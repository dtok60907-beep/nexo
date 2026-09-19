import { NextResponse } from 'next/server'

import type { Sql } from '@/lib/db'
import type { AuthenticatedUser } from '@/lib/main-session'

export function unauthorizedResponse() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function projectNotFoundResponse() {
  return NextResponse.json({ error: 'Project not found' }, { status: 404 })
}

export function folderNotFoundResponse() {
  return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
}

export function assetNotFoundResponse() {
  return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
}

export async function requireAuthenticatedUser(
  request: Request,
  getAuthenticatedUser: (request: Request) => Promise<AuthenticatedUser | null>,
) {
  const user = await getAuthenticatedUser(request)
  return user ?? null
}

export async function userOwnsProject(sql: Sql, userId: string, projectId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM projects WHERE id = ${projectId} AND userid = ${userId} LIMIT 1
  `
  return rows.length > 0
}

export async function userOwnsFolder(sql: Sql, userId: string, folderId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM asset_folders f
    JOIN projects p ON p.id = f.project_id
    WHERE f.id::text = ${folderId} AND p.userid = ${userId}
    LIMIT 1
  `
  return rows.length > 0
}

export async function findOwnedGenerationAsset(sql: Sql, userId: string, assetId: string) {
  const rows = await sql`
    SELECT g.id, g.project_id, g.r2_url
    FROM generation_history g
    JOIN projects p ON p.id::text = g.project_id::text
    WHERE p.userid = ${userId} AND g.id::text = ${assetId}
    LIMIT 1
  ` as Array<{ id: string; project_id: string; r2_url: string | null }>

  return rows[0] ?? null
}

export async function deleteEmptyAssetFolders(sql: Sql, folderIds: string[]): Promise<number> {
  if (folderIds.length === 0) return 0

  const rows = await sql`
    DELETE FROM asset_folders f
    WHERE f.id::text = ANY(${folderIds}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM asset_folder_items i WHERE i.folder_id = f.id
      )
    RETURNING f.id
  ` as Array<{ id: string }>

  return rows.length
}

export async function countOwnedGenerationAssetsForProject(
  sql: Sql,
  userId: string,
  projectId: string,
  assetIds: string[],
): Promise<number> {
  if (assetIds.length === 0) return 0

  const rows = await sql`
    SELECT count(*)::int AS owned_count
    FROM generation_history g
    JOIN projects p ON p.id::text = g.project_id::text
    WHERE p.userid = ${userId}
      AND g.project_id = ${projectId}
      AND g.id = ANY(${assetIds}::text[])
  ` as Array<{ owned_count: number }>

  return Number(rows[0]?.owned_count ?? 0)
}
