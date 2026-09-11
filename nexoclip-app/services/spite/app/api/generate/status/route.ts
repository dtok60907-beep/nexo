import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/db'
import { createTerminalGenerationPatch } from '@/lib/durable-generation'
import {
  createNexoClipGenerationClient,
  type NexoClipGenerationClient,
} from '@/lib/nexoclip-generation-client'
import { getAuthenticatedUser } from '@/lib/main-session'
import {
  projectNotFoundResponse,
  unauthorizedResponse,
  userOwnsProject,
} from '@/lib/project-ownership'
import {
  createInternalRealtimeClient,
  type InternalRealtimeClient,
} from '@/lib/realtime/internal-client'

interface GenerateStatusDeps {
  getDb?: typeof getDb
  getAuthenticatedUser?: typeof getAuthenticatedUser
  createNexoClipGenerationClient?: () => NexoClipGenerationClient
  createInternalRealtimeClient?: () => InternalRealtimeClient
}

export function createGenerateStatusHandler(deps: GenerateStatusDeps = {}) {
  const db = deps.getDb ?? getDb
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser
  const createGenerationClient = deps.createNexoClipGenerationClient ?? createNexoClipGenerationClient
  const createRealtimeClient = deps.createInternalRealtimeClient ?? createInternalRealtimeClient

  return async function GET(request: Request) {
    try {
      const { searchParams } = new URL(request.url)
      const projectId = searchParams.get('projectId') || undefined
      const user = await resolveUser(request)
      if (!user) return unauthorizedResponse()
      if (!projectId || !(await userOwnsProject(db(), user.id, projectId))) return projectNotFoundResponse()

      const nodeId = searchParams.get('nodeId') || undefined
      const generationId = searchParams.get('generationId') || undefined
      if (!nodeId || !generationId || !/^[a-zA-Z0-9_-]{1,200}$/.test(generationId)) {
        return NextResponse.json({ error: 'nodeId and a valid generationId are required' }, { status: 400 })
      }

      const realtime = createRealtimeClient()
      const document = await realtime.exportDocument({ userId: user.id, projectId })
      const node = document.projection.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.data.generationId !== generationId) return projectNotFoundResponse()

      const generation = await createGenerationClient().status({ userId: user.id, projectId, nodeId, generationId })
      const patch = createTerminalGenerationPatch(generation)
      if (patch && Object.entries(patch).some(([key, value]) => node.data[key] !== value)) {
        await realtime.patchNodeData({ userId: user.id, projectId, nodeId, set: patch })
      }

      const outputUrl = patch?.outputUrl as string | undefined
      const error = patch?.generationError as string | null | undefined
      return NextResponse.json({
        generationId: generation.id,
        generationStatus: patch?.generationStatus ?? (generation.status === 'queued' ? 'queued' : 'processing'),
        ...(outputUrl ? { outputUrl } : {}),
        ...(error ? { error } : {}),
      })
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'Status check failed' }, { status: Number(error?.status) || 500 })
    }
  }
}

const GET_HANDLER = createGenerateStatusHandler()

export async function GET(request: NextRequest) {
  return GET_HANDLER(request)
}
