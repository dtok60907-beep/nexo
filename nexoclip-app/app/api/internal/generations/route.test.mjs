import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalGenerationHandler } from './route.js';
import { createCanvasAuthorizationActionDigest, signCanvasAuthorization } from '../../../../src/lib/realtime/internalAuth.js';

const userId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';

function request(body) {
  return new Request('http://app/api/internal/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('submits a signed image job into the caller default workspace', async () => {
  let reserved;
  const handler = createInternalGenerationHandler({
    verify: () => true,
    getDefaultWorkspace: async () => ({ id: 'workspace-1' }),
    reserve: async (_pool, workspaceId, input, actor) => {
      reserved = { workspaceId, input, actor };
      return {
        id: 'generation-1', workspaceId, kind: 'image', status: 'queued',
        prompt: input.prompt, createdBy: actor.userId,
      };
    },
    getPool: () => ({}),
  });

  const response = await handler(request({
    action: 'submit', userId, projectId, nodeId: 'node-1',
    input: {
      kind: 'image', prompt: 'red kite', model: 'google/gemini-image',
      parameters: { aspectRatio: '1:1' }, idempotencyKey: 'spite:project-1:node-1:nonce-1',
    },
  }));

  assert.equal(response.status, 201);
  assert.equal((await response.json()).generation.id, 'generation-1');
  assert.deepEqual(reserved, {
    workspaceId: 'workspace-1',
    input: {
      kind: 'image', prompt: 'red kite', model: 'google/gemini-image',
      parameters: { aspectRatio: '1:1' }, idempotencyKey: 'spite:project-1:node-1:nonce-1', projectId: null,
    },
    actor: { userId },
  });
});

test('rejects a valid signature when the signed submit input was altered', async () => {
  const secret = process.env.CANVAS_AUTH_SECRET;
  process.env.CANVAS_AUTH_SECRET = 'bridge-secret';
  const input = { kind: 'image', prompt: 'red kite', model: 'model-1', idempotencyKey: 'spite:1' };
  const authorization = {
    userId, projectId, timestamp: Math.floor(Date.now() / 1000), nonce: 'nonce-1',
    actionDigest: createCanvasAuthorizationActionDigest({ action: 'submit', input, generationId: undefined }),
  };
  let lookedUp = false;
  const handler = createInternalGenerationHandler({
    getDefaultWorkspace: async () => { lookedUp = true; return null; },
  });
  try {
    const response = await handler(request({
      ...authorization, signature: signCanvasAuthorization(authorization, 'bridge-secret'),
      action: 'submit', userId, projectId, nodeId: 'node-1',
      input: { ...input, prompt: 'blue kite' },
    }));
    assert.equal(response.status, 404);
    assert.equal(lookedUp, false);
  } finally {
    if (secret === undefined) delete process.env.CANVAS_AUTH_SECRET;
    else process.env.CANVAS_AUTH_SECRET = secret;
  }
});

test('rejects unsigned bridge requests before workspace lookup', async () => {
  let lookedUp = false;
  const handler = createInternalGenerationHandler({
    verify: () => false,
    getDefaultWorkspace: async () => { lookedUp = true; return null; },
  });

  const response = await handler(request({ action: 'status', userId, projectId, nodeId: 'node-1', generationId: 'generation-1' }));

  assert.equal(response.status, 404);
  assert.equal(lookedUp, false);
});

test('reads status only from the caller default workspace and hides missing jobs', async () => {
  let readWorkspaceId;
  const handler = createInternalGenerationHandler({
    verify: () => true,
    getDefaultWorkspace: async () => ({ id: 'workspace-1' }),
    getGeneration: async (workspaceId) => { readWorkspaceId = workspaceId; return null; },
    createStorage: () => ({}),
  });

  const response = await handler(request({ action: 'status', userId, projectId, nodeId: 'node-1', generationId: 'generation-1' }));

  assert.equal(response.status, 404);
  assert.equal(readWorkspaceId, 'workspace-1');
});

test('rejects unsupported generation kinds without reserving credits', async () => {
  let reserved = false;
  const handler = createInternalGenerationHandler({
    verify: () => true,
    getDefaultWorkspace: async () => ({ id: 'workspace-1' }),
    reserve: async () => { reserved = true; },
  });

  const response = await handler(request({
    action: 'submit', userId, projectId, nodeId: 'node-1',
    input: { kind: 'audio', prompt: 'red kite', model: 'model-1', idempotencyKey: 'spite:1' },
  }));

  assert.equal(response.status, 400);
  assert.equal(reserved, false);
});
