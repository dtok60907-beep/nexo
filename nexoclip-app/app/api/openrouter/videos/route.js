import { createProviderRouter } from '../../../../src/providers/providerRouter.js';
import { SESSION_COOKIE } from '../../../../src/lib/auth/session.js';
import { resolveTenantContext } from '../../../../src/services/tenantContext.js';
import { getPool } from '../../../../src/db/pool.js';
import { createJob as createJobService, updateJobStatus as updateJobStatusService } from '../../../../src/services/jobService.js';

export function createVideoSubmitHandler({
  resolveTenant = resolveTenantContext,
  env = process.env,
  submitVideo = (params) => createProviderRouter({ env }).submitVideo(params),
  createJob = createJobService,
  updateJobStatus = updateJobStatusService,
  pool,
} = {}) {
  return async function POST(request) {
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!body?.model || !body?.prompt) {
      return Response.json({ error: 'model and prompt are required' }, { status: 400 });
    }
    const references = [
      ...(body.input_references || []).map((item) => item?.image_url?.url),
      ...(body.frame_images || []).map((item) => item?.image_url?.url ?? item?.url),
    ];
    if (references.some((value) => typeof value === 'string' && /^\s*asset:\/\//i.test(value))) {
      return Response.json({ error: 'Invalid asset reference', code: 'INVALID_REFERENCE_IMAGE' }, { status: 400 });
    }

    let tenant;
    try {
      const workspaceId = request.headers.get('x-workspace-id');
      if (!workspaceId) return Response.json({ error: 'x-workspace-id is required' }, { status: 400 });
      tenant = await resolveTenant({ token: request.cookies.get(SESSION_COOKIE)?.value, workspaceId });
    } catch (error) {
      return Response.json({ error: error.message }, { status: error.message === 'Authentication required' ? 401 : 403 });
    }

    try {
      const result = await submitVideo({
        model: body.model,
        prompt: body.prompt,
        duration: body.duration,
        resolution: body.resolution,
        aspectRatio: body.aspect_ratio,
        generateAudio: body.generate_audio,
        seed: body.seed,
        frameImages: body.frame_images,
        referenceImages: (body.input_references || []).map((item) => item?.image_url?.url).filter(Boolean),
        referenceVideos: (body.input_references || []).map((item) => item?.video_url?.url).filter(Boolean),
      });

      const job = await createJob({
        // Lazily resolved: only touched by consumers that actually read it, so
        // an injected createJob (tests) never forces a real DB pool to exist.
        get pool() { return pool ?? getPool(); },
        workspaceId: tenant.workspace.id,
        kind: 'video',
        params: { providerId: result.id, provider: result.provider || 'openrouter', model: body.model, prompt: body.prompt },
      });
      try {
        await updateJobStatus({
          get pool() { return pool ?? getPool(); },
          workspaceId: tenant.workspace.id,
          id: job.id,
          status: 'running',
        });
      } catch {
        // Job tracking is best-effort; submission already succeeded.
      }

      return Response.json(
        { id: result.id, job_id: job.id, status: 'queued', polling_url: result.polling_url },
        { status: 202 },
      );
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      return Response.json({ error: error?.message || 'Video generation failed', code: error?.code, model: body?.model, provider: error?.provider }, { status });
    }
  };
}

export const POST = createVideoSubmitHandler();
