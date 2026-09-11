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
      const mobile = body.mobile === true
      const kind = body.kind === 'image' || body.kind === 'video' ? body.kind : undefined
      const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
      const model = typeof body.model === 'string' ? body.model : typeof body.modelId === 'string' ? body.modelId : undefined
      if (!nodeId || !kind || !prompt || !model) {
        return NextResponse.json({ error: 'projectId, nodeId, kind, prompt, and model are required' }, { status: 400 })
      }

      const realtime = createRealtimeClient()
      if (!mobile) {
        const document = await realtime.exportDocument({ userId: user.id, projectId })
        const node = document.projection.nodes.find((candidate) => candidate.id === nodeId)
        if (!node || node.type !== (kind === 'image' ? 'imageGen' : 'videoGen')) return projectNotFoundResponse()
      }

      const parameters = mapLegacyParameters(body, kind)
      const generation = await createGenerationClient().submit({
        userId: user.id,
        projectId,
        nodeId,
        input: { kind, prompt, model, parameters, idempotencyKey: `spite:${projectId}:${nodeId}:${crypto.randomUUID()}` },
      })
      if (!mobile) {
        await realtime.patchNodeData({
          userId: user.id,
          projectId,
          nodeId,
          set: createQueuedGenerationPatch(generation),
        })
      }

      return NextResponse.json({ generationId: generation.id, generationStatus: 'queued' }, { status: 202 })
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'Generation failed' }, { status: Number(error?.status) || 500 })
    }
  }
}

function mapLegacyParameters(body: Record<string, unknown>, kind: 'image' | 'video'): Record<string, unknown> {
  const settings = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
    ? body.settings as Record<string, unknown>
    : {}
  const allowed = kind === 'image'
    ? new Set(['aspectRatio', 'resolution', 'quality', 'seed', 'name', 'swap_url'])
    : new Set(['aspectRatio', 'duration', 'resolution', 'seed', 'videoUrl'])
  const unsupported = Object.keys(settings).filter((key) => !allowed.has(key))
  if (unsupported.length) {
    throw Object.assign(new Error(`Unsupported durable generation parameters: ${unsupported.join(', ')}`), { status: 400 })
  }

  const referenceImages = collectReferences(body)
  if (kind === 'image') {
    if (body.endImageUrl !== undefined) {
      throw Object.assign(new Error('endImageUrl is only supported for video generations'), { status: 400 })
    }
    const parameters: Record<string, unknown> = {}
    for (const key of allowed) if (settings[key] !== undefined) parameters[key] = settings[key]
    if (referenceImages.length) parameters.referenceImages = referenceImages
    return parameters
  }

  const frameImages = [
    typeof body.referenceImageUrl === 'string' ? { url: body.referenceImageUrl, frameType: 'first_frame' } : undefined,
    typeof body.endImageUrl === 'string' ? { url: body.endImageUrl, frameType: 'last_frame' } : undefined,
  ].filter(Boolean)
  const videoUrl = typeof settings.videoUrl === 'string' ? settings.videoUrl : undefined
  const tenantReferences = [...referenceImages, ...frameImages.map((frame) => frame!.url), ...(videoUrl ? [videoUrl] : [])]
  if (tenantReferences.some((url) => !/^\/api\/assets\/[^/]+\/download(?:\?|$)/.test(url))) {
    throw Object.assign(new Error('Video references must be tenant asset URLs (/api/assets/:id/download)'), { status: 400 })
  }
  const parameters: Record<string, unknown> = {}
  for (const key of ['aspectRatio', 'resolution', 'seed']) if (settings[key] !== undefined) parameters[key] = settings[key]
  if (settings.duration !== undefined) parameters.duration = Number.parseInt(String(settings.duration), 10)
  if (referenceImages.length) parameters.referenceImages = referenceImages
  if (videoUrl) parameters.referenceVideos = [videoUrl]
  if (frameImages.length) parameters.frameImages = frameImages
  return parameters
}

function collectReferences(body: Record<string, unknown>): string[] {
  const references = [
    typeof body.referenceImageUrl === 'string' ? body.referenceImageUrl : undefined,
    ...(Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : []),
    ...(Array.isArray(body.referenceGroups)
      ? body.referenceGroups.flatMap((group) => group && typeof group === 'object' && Array.isArray((group as { urls?: unknown }).urls)
        ? (group as { urls: unknown[] }).urls
        : [])
      : []),
  ]
  return [...new Set(references.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

const POST_HANDLER = createGenerateSubmitHandler()

export async function POST(request: NextRequest) {
  return POST_HANDLER(request)
}
