import test from 'node:test';
import assert from 'node:assert/strict';
import { createBytePlusAdapter } from '../../src/providers/direct/byteplusAdapter.js';
import { createProviderRouter, markTrustedAssetRequest } from '../../src/providers/providerRouter.js';

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body };
}

test('sends a BytePlus Seedance deployment endpoint directly', async () => {
  const calls = [];
  let bytePlusBody;
  const router = createProviderRouter({
    env: { OPENROUTER_API_KEY: 'or-key', BYTEPLUS_API_KEY: 'bp-key', BYTEPLUS_BASE_URL: 'https://ark.example/api/v3' },
    fetch: async (url, options) => {
      calls.push(url);
      bytePlusBody = JSON.parse(options.body);
      return jsonResponse({ id: 'cgt-1', status: 'queued' });
    },
  });

  const result = await router.submitVideo({ model: 'ep-20260904190604-p8pjl', prompt: 'a cat running', duration: 10 });

  assert.equal(result.provider, 'byteplus');
  assert.equal(bytePlusBody.model, 'ep-20260904190604-p8pjl');
  assert.equal(bytePlusBody.duration, 10);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ark\.example\/api\/v3\/contents\/generations\/tasks/);
});

test('routes registered Seedance with trusted assets directly without calling OpenRouter', async () => {
  const calls = [];
  let bytePlusBody;
  const router = createProviderRouter({
    env: { OPENROUTER_API_KEY: 'or-key', BYTEPLUS_API_KEY: 'bp-key', BYTEPLUS_BASE_URL: 'https://ark.example/api/v3' },
    fetch: async (url, options) => {
      calls.push(url);
      if (url.includes('openrouter.ai')) throw new Error('trusted asset reached OpenRouter');
      bytePlusBody = JSON.parse(options.body);
      return jsonResponse({ id: 'cgt-1', status: 'queued' });
    },
  });

  const result = await router.submitVideo(markTrustedAssetRequest({
    model: 'bytedance/seedance-2.5',
    prompt: 'a cat running',
    referenceImages: ['asset://trusted-reference'],
    frameImages: [{ image_url: { url: 'asset://trusted-frame' }, frame_type: 'first_frame' }],
  }));

  assert.equal(result.provider, 'byteplus');
  assert.equal(bytePlusBody.model, 'dreamina-seedance-2-5-260628');
  assert.deepEqual(bytePlusBody.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url), [
    'asset://trusted-reference',
    'asset://trusted-frame',
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ark\.example/);
});

test('falls back to BytePlus Seedance 2.5 when OpenRouter returns a generic 400', async () => {
  const calls = [];
  let bytePlusBody;
  const router = createProviderRouter({
    env: { OPENROUTER_API_KEY: 'or-key', BYTEPLUS_API_KEY: 'bp-key', BYTEPLUS_BASE_URL: 'https://ark.example/api/v3' },
    fetch: async (url, options) => {
      calls.push(url);
      if (url.includes('openrouter.ai')) return jsonResponse({ error: { message: 'Bad Request' } }, { status: 400 });
      bytePlusBody = JSON.parse(options.body);
      return jsonResponse({ id: 'cgt-1', status: 'queued' });
    },
  });

  const result = await router.submitVideo({ model: 'bytedance/seedance-2.5', prompt: 'a cat running' });

  assert.equal(result.provider, 'byteplus');
  assert.equal(bytePlusBody.model, 'dreamina-seedance-2-5-260628');
  assert.equal(calls.length, 2);
});

test('submit posts to the async /tasks endpoint, not /contents/generations', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url, options) => { request = { url, options }; return jsonResponse({ id: 'cgt-1' }); },
  });
  await adapter.submit({ model: 'dreamina-seedance-2-0-260128', prompt: 'a cat' });
  assert.equal(request.url, 'https://ark.example/api/v3/contents/generations/tasks');
});

test('submit sends reference videos with the reference_video role BytePlus requires', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url, options) => { request = { url, options }; return jsonResponse({ id: 'cgt-1' }); },
  });
  await adapter.submit({ model: 'dreamina-seedance-2-0-260128', prompt: 'remove watermark', referenceVideos: ['https://cdn.example/in.mp4'] });
  const body = JSON.parse(request.options.body);
  assert.deepEqual(
    body.content.find((part) => part.type === 'video_url'),
    { type: 'video_url', role: 'reference_video', video_url: { url: 'https://cdn.example/in.mp4' } },
  );
});

test('submit converts frame images to BytePlus reference images', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url, options) => { request = { url, options }; return jsonResponse({ id: 'cgt-1' }); },
  });
  await adapter.submit({
    model: 'ep-20260904190604-p8pjl',
    prompt: 'animate this image',
    duration: 5,
    frameImages: [{ type: 'image_url', image_url: { url: 'https://cdn.example/start.jpg' }, frame_type: 'first_frame' }],
  });
  const body = JSON.parse(request.options.body);
  assert.deepEqual(
    body.content.find((part) => part.type === 'image_url'),
    { type: 'image_url', role: 'reference_image', image_url: { url: 'https://cdn.example/start.jpg' } },
  );
  assert.equal(body.duration, 5);
});

test('submit appends frame images after reference images without changing reference indices', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url, options) => { request = { url, options }; return jsonResponse({ id: 'cgt-1' }); },
  });

  await adapter.submit({
    model: 'dreamina-seedance-2-0-mini-260615',
    prompt: 'animate mixed inputs',
    referenceImages: ['asset://reference-zero', 'https://cdn.example/reference-one.jpg'],
    frameImages: [
      { image_url: { url: 'asset://frame-zero' }, frame_type: 'first_frame' },
      { image_url: { url: 'https://cdn.example/frame-one.jpg' }, frame_type: 'last_frame' },
    ],
  });

  const body = JSON.parse(request.options.body);
  assert.deepEqual(
    body.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
    ['asset://reference-zero', 'https://cdn.example/reference-one.jpg', 'asset://frame-zero', 'https://cdn.example/frame-one.jpg'],
  );
});

test('submit preserves trusted asset URIs and reference image ordering', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url, options) => { request = { url, options }; return jsonResponse({ id: 'cgt-1' }); },
  });

  await adapter.submit({
    model: 'dreamina-seedance-2-0-mini-260615',
    prompt: 'animate in order',
    referenceImages: ['asset://provider-first', 'data:image/png;base64,c2Vjb25k', 'asset://provider-third'],
  });

  const body = JSON.parse(request.options.body);
  assert.deepEqual(
    body.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
    ['asset://provider-first', 'data:image/png;base64,c2Vjb25k', 'asset://provider-third'],
  );
});

test('submit sends reference images with the reference_image role BytePlus requires', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url, options) => { request = { url, options }; return jsonResponse({ id: 'cgt-1' }); },
  });
  await adapter.submit({ model: 'dreamina-seedance-2-0-mini-260615', prompt: 'a person wearing this outfit', referenceImages: ['https://cdn.example/person.jpg', 'https://cdn.example/outfit.jpg'] });
  const body = JSON.parse(request.options.body);
  assert.deepEqual(
    body.content.filter((part) => part.type === 'image_url'),
    [
      { type: 'image_url', role: 'reference_image', image_url: { url: 'https://cdn.example/person.jpg' } },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'https://cdn.example/outfit.jpg' } },
    ],
  );
});

test('poll reads from the /tasks endpoint', async () => {
  let request;
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url) => { request = { url }; return jsonResponse({ id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://tos.example/out.mp4' } }); },
  });
  const result = await adapter.poll('cgt-1');
  assert.equal(request.url, 'https://ark.example/api/v3/contents/generations/tasks/cgt-1');
  assert.equal(result.content.video_url, 'https://tos.example/out.mp4');
});

test('submit surfaces the real BytePlus error detail instead of a generic message', async () => {
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async () => jsonResponse({ error: { code: 'InvalidParameter', message: 'the parameter duration specified in the request is not valid' } }, { status: 400 }),
  });
  await assert.rejects(
    adapter.submit({ model: 'dreamina-seedance-2-0-mini-260615', prompt: 'test', duration: 999 }),
    (error) => {
      assert.match(error.message, /duration specified in the request is not valid/);
      assert.equal(error.code, 'BYTEPLUS_REQUEST_FAILED');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('downloadContent reads the single-object content shape and fetches the pre-signed TOS URL directly (not through the Ark host)', async () => {
  const calls = [];
  const adapter = createBytePlusAdapter({
    apiKey: 'secret', baseUrl: 'https://ark.example/api/v3',
    fetch: async (url) => {
      calls.push(url);
      if (url.includes('ark.example')) return jsonResponse({ status: 'succeeded', content: { video_url: 'https://tos.example/out.mp4?sig=abc' } });
      return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    },
  });
  const result = await adapter.downloadContent('cgt-1');
  assert.equal(calls[1], 'https://tos.example/out.mp4?sig=abc');
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.buffer.length, 3);
});
