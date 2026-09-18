import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoSubmitHandler } from '../../app/api/openrouter/videos/route.js';

function postReq(body) {
  const r = new Request('http://app/api/openrouter/videos', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws-1' },
    body: JSON.stringify(body),
  });
  r.cookies = { get: (n) => (n === 'nexoclip_session' ? { value: 'tok' } : undefined) };
  return r;
}

test('submitting a video creates a durable video job and returns its id', async () => {
  let created;
  const handler = createVideoSubmitHandler({
    resolveTenant: async () => ({ workspace: { id: 'ws-1' } }),
    env: { OPENROUTER_API_KEY: 'k' },
    submitVideo: async () => ({ id: 'or-1', polling_url: 'p', status: 'pending' }),
    createJob: async ({ workspaceId, kind }) => {
      created = { workspaceId, kind };
      return { id: 'job-1', status: 'queued' };
    },
  });
  const res = await handler(postReq({ model: 'google/veo-3.1', prompt: 'a cat' }));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.job_id, 'job-1');
  assert.deepEqual(created, { workspaceId: 'ws-1', kind: 'video' });
});

test('extracts a video_url input_reference into referenceVideos for video-to-video submits', async () => {
  let submittedParams;
  const handler = createVideoSubmitHandler({
    resolveTenant: async () => ({ workspace: { id: 'ws-1' } }),
    env: { OPENROUTER_API_KEY: 'k' },
    submitVideo: async (params) => { submittedParams = params; return { id: 'or-1', polling_url: 'p', status: 'pending' }; },
    createJob: async () => ({ id: 'job-1', status: 'queued' }),
  });
  const res = await handler(postReq({
    model: 'runway/aleph-2',
    prompt: 'make it night time',
    input_references: [{ type: 'video_url', video_url: { url: 'https://cdn.example/in.mp4' } }],
  }));
  assert.equal(res.status, 202);
  assert.deepEqual(submittedParams.referenceVideos, ['https://cdn.example/in.mp4']);
  assert.deepEqual(submittedParams.referenceImages, []);
});

test('rejects client asset URIs before public video submission', async () => {
  let submissions = 0;
  const handler = createVideoSubmitHandler({
    resolveTenant: async () => ({ workspace: { id: 'ws-1' } }),
    submitVideo: async () => { submissions += 1; return { id: 'unsafe' }; },
  });

  for (const body of [
    { model: 'bytedance/seedance-2.5', prompt: 'x', input_references: [{ image_url: { url: 'asset://attacker' } }] },
    { model: 'bytedance/seedance-2.5', prompt: 'x', frame_images: [{ image_url: { url: ' ASSET://attacker' } }] },
  ]) {
    const response = await handler(postReq(body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REFERENCE_IMAGE');
  }
  assert.equal(submissions, 0);
});

test('stores provider polling metadata and marks the durable video job running', async () => {
  let createdParams; let updated;
  const handler = createVideoSubmitHandler({
    resolveTenant: async () => ({ workspace: { id: 'ws-1' } }),
    submitVideo: async () => ({ id: 'provider-1', provider: 'byteplus', polling_url: 'p' }),
    createJob: async ({ params }) => { createdParams = params; return { id: 'job-1' }; },
    updateJobStatus: async (args) => { updated = args; },
  });
  await handler(postReq({ model: 'seedance', prompt: 'a cat' }));
  assert.deepEqual(createdParams, { providerId: 'provider-1', provider: 'byteplus', model: 'seedance', prompt: 'a cat' });
  assert.equal(updated.status, 'running');
});

test('missing model/prompt is 400 before any job is created', async () => {
  let calls = 0;
  const handler = createVideoSubmitHandler({
    resolveTenant: async () => ({ workspace: { id: 'ws-1' } }),
    env: { OPENROUTER_API_KEY: 'k' },
    submitVideo: async () => ({ id: 'x' }),
    createJob: async () => { calls += 1; return { id: 'j' }; },
  });
  const res = await handler(postReq({ prompt: 'no model' }));
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
});
