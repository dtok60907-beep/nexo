import { NextRequest, NextResponse } from 'next/server'

import { getDb } from '@/lib/db'
import {
  createNexoClipGenerationClient,
  type NexoClipGenerationClient,
} from '@/lib/nexoclip-generation-client'
import { createQueuedGenerationPatch } from '@/lib/durable-generation'
import { getModelById } from '@/lib/fal-models'
import { getAuthenticatedUser } from '@/lib/main-session'
import {
  assetNotFoundResponse,
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
      const sql = db()
      if (!projectId || !(await userOwnsProject(sql, user.id, projectId))) return projectNotFoundResponse()

      const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined
      const mobile = body.mobile === true
      const kind = body.kind === 'image' || body.kind === 'video' ? body.kind : undefined
      const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
      const modelId = typeof body.model === 'string' ? body.model : typeof body.modelId === 'string' ? body.modelId : undefined
      if (!nodeId || !kind || !prompt || !modelId) {
        return NextResponse.json({ error: 'projectId, nodeId, kind, prompt, and model are required' }, { status: 400 })
      }
      const configuredModel = getModelById(modelId)
      const model = configuredModel && configuredModel.category === kind
        ? `${configuredModel.provider}/${configuredModel.providerModel}`
        : modelId

      const realtime = createRealtimeClient()
      if (!mobile) {
        const document = await realtime.exportDocument({ userId: user.id, projectId })
        const node = document.projection.nodes.find((candidate) => candidate.id === nodeId)
        if (!node || node.type !== (kind === 'image' ? 'imageGen' : 'videoGen')) return projectNotFoundResponse()
        if (typeof node.data.generationId === 'string' && ['queued', 'processing', 'running'].includes(String(node.data.generationStatus))) {
          return NextResponse.json({ error: 'This node already has an active generation' }, { status: 409 })
        }
      }

      const references = collectReferences(body)
      const legacyReferences = references.filter(isLegacyCanvasReference)
      if (legacyReferences.length && !(await projectOwnsLegacyReferences(sql, projectId, legacyReferences))) {
        return assetNotFoundResponse()
      }

      const parameters = mapLegacyParameters(body, kind)
      if (isBytePlusSeedance(model) && !hasOnlyCanonicalAssetReferences(parameters)) {
        return NextResponse.json({
          error: 'Every Seedance reference must be imported into Assets and active in Trust for Seedance.',
          code: 'BYTEPLUS_REFERENCE_NOT_TRUSTED',
        }, { status: 422 })
      }
      const supportedRatios = configuredModel?.aspectRatios ?? ['1:1', '16:9', '9:16', '4:3', '3:4']
      if (parameters.aspectRatio === 'auto') delete parameters.aspectRatio
      else if (parameters.aspectRatio !== undefined && !supportedRatios.includes(String(parameters.aspectRatio))) {
        return NextResponse.json({ error: `Aspect ratio is not supported by ${configuredModel?.name ?? 'this model'}` }, { status: 400 })
      }
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
    for (const key of allowed) if (settings[key] !== undefined && settings[key] !== '') parameters[key] = settings[key]
    if (referenceImages.length) parameters.referenceImages = referenceImages
    return parameters
  }

  const frameImages = [
    typeof body.referenceImageUrl === 'string' ? { url: body.referenceImageUrl, frameType: 'first_frame' } : undefined,
    typeof body.endImageUrl === 'string' ? { url: body.endImageUrl, frameType: 'last_frame' } : undefined,
  ].filter(Boolean)
  const videoUrl = typeof settings.videoUrl === 'string' ? settings.videoUrl : undefined
  const tenantReferences = [...referenceImages, ...frameImages.map((frame) => frame!.url), ...(videoUrl ? [videoUrl] : [])]
  if (tenantReferences.some((url) => !/^\/api\/assets\/[^/]+\/download(?:\?|$)/.test(url) && !isLegacyCanvasReference(url))) {
    throw Object.assign(new Error('Video references must be tenant assets or owned Canvas references'), { status: 400 })
  }
  if (settings.aspectRatio !== undefined && settings.aspectRatio !== '' && settings.aspectRatio !== '9:16') {
    throw Object.assign(new Error('Video generation is portrait-only (9:16).'), { status: 400 })
  }
  const parameters: Record<string, unknown> = { aspectRatio: '9:16' }
  for (const key of ['resolution', 'seed']) if (settings[key] !== undefined && settings[key] !== '') parameters[key] = settings[key]
  if (settings.duration !== undefined) parameters.duration = Number.parseInt(String(settings.duration), 10)
  if (referenceImages.length) parameters.referenceImages = referenceImages
  if (videoUrl) parameters.referenceVideos = [videoUrl]
  if (frameImages.length) parameters.frameImages = frameImages
  return parameters
}

function isBytePlusSeedance(model: string): boolean {
  return /(?:^|\/)(?:dreamina-)?seedance(?:[-.]|$)/i.test(model) || /^ep-20260916130618-t2z5j$/i.test(model)
}

function hasOnlyCanonicalAssetReferences(parameters: Record<string, unknown>): boolean {
  const urls = [
    ...(Array.isArray(parameters.referenceImages) ? parameters.referenceImages : []),
    ...(Array.isArray(parameters.referenceVideos) ? parameters.referenceVideos : []),
    ...(Array.isArray(parameters.frameImages) ? parameters.frameImages.map((frame) => frame && typeof frame === 'object' ? (frame as { url?: unknown }).url : undefined) : []),
  ]
  return urls.every((url) => typeof url === 'string' && /^\/api\/assets\/[^/]+\/download(?:\?|$)/.test(url))
}

function isLegacyCanvasReference(url: string): boolean {
  return /^\/(?:spite\/)?api\/r2-image\/.+/.test(url)
}

async function projectOwnsLegacyReferences(sql: ReturnType<typeof getDb>, projectId: string, references: string[]): Promise<boolean> {
  const normalizedReferences = [...new Set(references.map((url) => url.replace(/^\/spite/, '')))]
  const rows = await sql`
    SELECT count(DISTINCT regexp_replace(r2_url, '^/spite', ''))::int AS owned_count
    FROM generation_history
    WHERE project_id = ${projectId}
      AND regexp_replace(r2_url, '^/spite', '') = ANY(${normalizedReferences}::text[])
  ` as Array<{ owned_count: number }>
  return Number(rows[0]?.owned_count ?? 0) === normalizedReferences.length
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
