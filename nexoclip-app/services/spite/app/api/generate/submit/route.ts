import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/db'
import {
  createNexoClipGenerationClient,
  type NexoClipGenerationClient,
} from '@/lib/nexoclip-generation-client'
import { createQueuedGenerationPatch } from '@/lib/durable-generation'
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

interface GenerateSubmitDeps {
  getDb?: typeof getDb
  getAuthenticatedUser?: typeof getAuthenticatedUser
  createNexoClipGenerationClient?: () => NexoClipGenerationClient
  createInternalRealtimeClient?: () => InternalRealtimeClient
}

export function createGenerateSubmitHandler(deps: GenerateSubmitDeps = {}) {
  const db = deps.getDb ?? getDb
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser
  const createGenerationClient = deps.createNexoClipGenerationClient ?? createNexoClipGenerationClient
  const createRealtimeClient = deps.createInternalRealtimeClient ?? createInternalRealtimeClient

  return async function POST(request: Request) {
    if (process.env.GENERATION_DISABLED === '1') {
      return NextResponse.json({ error: 'Generation is currently disabled by admin.' }, { status: 503 })
    }

    try {
      const body = await request.json()
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
      const user = await resolveUser(request)
      if (!user) return unauthorizedResponse()
      if (!projectId || !(await userOwnsProject(db(), user.id, projectId))) return projectNotFoundResponse()

      const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined
      const kind = body.kind === 'image' || body.kind === 'video' ? body.kind : undefined
      const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
      const model = typeof body.model === 'string' ? body.model : typeof body.modelId === 'string' ? body.modelId : undefined
      if (!nodeId || !kind || !prompt || !model) {
        return NextResponse.json({ error: 'projectId, nodeId, kind, prompt, and model are required' }, { status: 400 })
      }

      const realtime = createRealtimeClient()
      const document = await realtime.exportDocument({ userId: user.id, projectId })
      const node = document.projection.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.type !== (kind === 'image' ? 'imageGen' : 'videoGen')) return projectNotFoundResponse()

      const parameters = {
        ...(body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : {}),
        ...(typeof body.referenceImageUrl === 'string' ? { referenceImageUrl: body.referenceImageUrl } : {}),
        ...(Array.isArray(body.referenceImageUrls) ? { referenceImageUrls: body.referenceImageUrls } : {}),
        ...(Array.isArray(body.referenceGroups) ? { referenceGroups: body.referenceGroups } : {}),
        ...(typeof body.endImageUrl === 'string' ? { endImageUrl: body.endImageUrl } : {}),
      }
      const generation = await createGenerationClient().submit({
        userId: user.id,
        projectId,
        nodeId,
        input: { kind, prompt, model, parameters, idempotencyKey: `spite:${projectId}:${nodeId}:${crypto.randomUUID()}` },
      })
      await realtime.patchNodeData({
        userId: user.id,
        projectId,
        nodeId,
        set: createQueuedGenerationPatch(generation),
      })

      return NextResponse.json({ generationId: generation.id, generationStatus: 'queued' }, { status: 202 })
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'Generation failed' }, { status: Number(error?.status) || 500 })
    }
  }
}

const POST_HANDLER = createGenerateSubmitHandler()

export async function POST(request: NextRequest) {
  return POST_HANDLER(request)
}
