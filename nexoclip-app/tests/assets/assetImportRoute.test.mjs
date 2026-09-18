import test from 'node:test';
import assert from 'node:assert/strict';

import { createAssetImportHandler } from '../../app/api/assets/import/route.js';

function request(file = new File([Buffer.from('image')], 'reference.png', { type: 'image/png' })) {
  const form = new FormData();
  form.append('file', file);
  return new Request('http://app.local/api/assets/import', { method: 'POST', body: form });
}

test('image import requires a main-app session', async () => {
  const handler = createAssetImportHandler({ getSession: async () => null });
  const response = await handler(request());
  assert.equal(response.status, 401);
});

test('image import stores bytes in the authenticated default workspace', async () => {
  let input;
  const handler = createAssetImportHandler({
    getSession: async () => ({ user_id: 'user-1' }),
    getWorkspace: async () => ({ id: 'workspace-1' }),
    resolveTenant: async ({ workspaceId }) => ({ workspace: { id: workspaceId } }),
    importAsset: async (...args) => {
      input = args;
      return { asset: { id: 'asset-1' }, url: '/api/assets/asset-1/download?workspace_id=workspace-1' };
    },
  });

  const response = await handler(request());
  assert.equal(response.status, 201);
  assert.equal(input[0], 'workspace-1');
  assert.equal(input[1].filename, 'reference.png');
  assert.equal(input[1].contentType, 'image/png');
  assert.deepEqual(input[1].body, Buffer.from('image'));
});

test('image import rejects non-image bodies before storage', async () => {
  let imported = false;
  const handler = createAssetImportHandler({
    getSession: async () => ({ user_id: 'user-1' }),
    getWorkspace: async () => ({ id: 'workspace-1' }),
    resolveTenant: async () => ({ workspace: { id: 'workspace-1' } }),
    importAsset: async () => { imported = true; },
  });
  const response = await handler(request(new File([Buffer.from('video')], 'clip.mp4', { type: 'video/mp4' })));
  assert.equal(response.status, 400);
  assert.equal(imported, false);
});
