import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRouter, markTrustedAssetRequest } from '../../src/providers/providerRouter.js';

const env = {
  BYTEPLUS_API_KEY: 'byteplus-key',
  BYTEPLUS_BASE_URL: 'https://ark.example/api/v3',
  BYTEPLUS_SEEDANCE_2_ENDPOINT: 'ep-video-20',
  BYTEPLUS_SEEDANCE_2_5_ENDPOINT: 'ep-video-25',
  BYTEPLUS_SEEDREAM_5_ENDPOINT: 'ep-image-50',
};

test('routes dedicated Seedance aliases directly to the video endpoint id', async () => {
  const calls = [];
  const router = createProviderRouter({ env, fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), { status: 200 });
  } });

  await router.submitVideo(markTrustedAssetRequest({
    model: 'byteplus/seedance-2.0-unfiltered',
    prompt: 'scene',
    referenceImages: ['asset://trusted-dedicated-reference'],
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ark.example/api/v3/contents/generations/tasks');
  assert.equal(calls[0].body.model, 'ep-video-20');
  assert.equal(calls[0].body.content[1].image_url.url, 'asset://trusted-dedicated-reference');
});

test('plain client-shaped asset URI does not trigger trusted direct routing', async () => {
  const calls = [];
  const router = createProviderRouter({ env, fetch: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
  } });

  await assert.rejects(router.submitVideo({
    model: 'bytedance/seedance-2.5', prompt: 'scene', referenceImages: ['asset://unmarked'],
  }), { code: 'INVALID_REFERENCE_IMAGE', status: 400 });

  assert.equal(calls.length, 0);
});

test('routes dedicated Seedream alias directly to the image endpoint id', async () => {
  const calls = [];
  const router = createProviderRouter({ env, fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: [{ url: 'https://output.example/image.png' }] }), { status: 200 });
  } });

  await router.generateImage({ model: 'byteplus/seedream-5.0-pro-unfiltered', prompt: 'portrait' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ark.example/api/v3/images/generations');
  assert.equal(calls[0].body.model, 'ep-image-50');
});

test('does not call OpenRouter or a base model when endpoint configuration is absent', async () => {
  let calls = 0;
  const router = createProviderRouter({
    env: { BYTEPLUS_API_KEY: 'key', BYTEPLUS_BASE_URL: 'https://ark.example/api/v3' },
    fetch: async () => { calls += 1; return new Response('{}', { status: 200 }); },
  });
  await assert.rejects(
    router.submitVideo({ model: 'byteplus/seedance-2.5-unfiltered', prompt: 'scene' }),
    (error) => error.code === 'BYTEPLUS_ENDPOINT_NOT_CONFIGURED',
  );
  assert.equal(calls, 0);
});
