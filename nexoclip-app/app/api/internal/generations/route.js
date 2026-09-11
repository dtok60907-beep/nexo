import { getPool } from '../../../../src/db/pool.js';
import { getDefaultWorkspace } from '../../../../src/services/workspaceService.js';
import { createImageGenerationJobWithReservation, getGenerationJob } from '../../../../src/services/generationService.js';
import { createStorage } from '../../../../src/services/assetService.js';
import { createCanvasAuthorizationActionDigest, verifyCanvasAuthorization } from '../../../../src/lib/realtime/internalAuth.js';

const ACTIONS = new Set(['submit', 'status']);
const KINDS = new Set(['image', 'video']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validInput(input) {
  return input && typeof input === 'object'
    && KINDS.has(input.kind)
    && typeof input.prompt === 'string' && input.prompt.trim()
    && typeof input.model === 'string' && input.model.trim()
    && typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim();
}

async function readBody(request) {
  try { return await request.json(); }
  catch { return null; }
}

export function createInternalGenerationHandler({
  verify = (payload, signature) => verifyCanvasAuthorization(payload, signature, process.env.CANVAS_AUTH_SECRET),
  getDefaultWorkspace: findDefaultWorkspace = getDefaultWorkspace,
  reserve = createImageGenerationJobWithReservation,
  getGeneration = getGenerationJob,
  getPool: loadPool = getPool,
  createStorage: loadStorage = createStorage,
} = {}) {
  return async function POST(request) {
    const body = await readBody(request);
    const authorization = {
      userId: body?.userId,
      projectId: body?.projectId,
      timestamp: body?.timestamp,
      nonce: body?.nonce,
      actionDigest: createDigest(body),
    };
    if (!verify(authorization, body?.signature)) return Response.json({ error: 'Not found' }, { status: 404 });
    if (!ACTIONS.has(body?.action) || !UUID.test(body?.userId) || !UUID.test(body?.projectId) || !body?.nodeId) {
      return Response.json({ error: 'Invalid internal generation request' }, { status: 400 });
    }

    const workspace = await findDefaultWorkspace(body.userId);
    if (!workspace) return Response.json({ error: 'Workspace not found' }, { status: 404 });

    if (body.action === 'submit') {
      if (!validInput(body.input)) return Response.json({ error: 'Invalid internal generation request' }, { status: 400 });
      const generation = await reserve(loadPool(), workspace.id, { ...body.input, projectId: null }, { userId: body.userId });
      return Response.json({ generation }, { status: 201 });
    }

    if (typeof body.generationId !== 'string' || !body.generationId) {
      return Response.json({ error: 'Invalid internal generation request' }, { status: 400 });
    }
    const generation = await getGeneration(workspace.id, body.generationId, loadStorage());
    if (!generation) return Response.json({ error: 'Generation not found' }, { status: 404 });
    return Response.json({ generation });
  };
}

function createDigest(body) {
  try {
    return createCanvasAuthorizationActionDigest({
      action: body?.action,
      input: body?.input,
      generationId: body?.generationId,
    });
  } catch { return ''; }
}

export const POST = createInternalGenerationHandler();
