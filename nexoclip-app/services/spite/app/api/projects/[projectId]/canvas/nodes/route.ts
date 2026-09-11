import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/db'
import { getAuthenticatedUser } from '@/lib/main-session'
import { projectNotFoundResponse, unauthorizedResponse, userOwnsProject } from '@/lib/project-ownership'
import { createInternalRealtimeClient, type InternalRealtimeClient } from '@/lib/realtime/internal-client'

interface CreateCanvasNodeDeps {
  getDb?: typeof getDb
  getAuthenticatedUser?: typeof getAuthenticatedUser
  createInternalRealtimeClient?: () => InternalRealtimeClient
}

export function createCanvasNodeHandler(deps: CreateCanvasNodeDeps = {}) {
  const db = deps.getDb ?? getDb
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser
  const createRealtimeClient = deps.createInternalRealtimeClient ?? createInternalRealtimeClient

  return async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
    try {
      const user = await resolveUser(request)
      if (!user) return unauthorizedResponse()
      const { projectId } = await params
      if (!(await userOwnsProject(db(), user.id, projectId))) return projectNotFoundResponse()

      const body = await request.json()
      const node = body?.id && body?.type && body?.position && body?.data
      if (!node || typeof body.id !== 'string' || !['imageGen', 'videoGen'].includes(body.type)
        || typeof body.position.x !== 'number' || typeof body.position.y !== 'number'
        || typeof body.data !== 'object' || Array.isArray(body.data)) {
        return NextResponse.json({ error: 'Invalid canvas node' }, { status: 400 })
      }

      await createRealtimeClient().createNode({
        userId: user.id,
        projectId,
        node: { id: body.id, type: body.type, position: body.position, data: body.data },
      })
      return NextResponse.json({ ok: true }, { status: 201 })
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'Could not create canvas node' }, { status: Number(error?.status) || 500 })
    }
  }
}

const HANDLER = createCanvasNodeHandler()

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  return HANDLER(request, context)
}
