import test from 'node:test';
import assert from 'node:assert/strict';
import { BytePlusAssetsError } from '../../src/providers/byteplusAssetsClient.js';
import { createBytePlusAssetTrustHandlers } from '../../app/api/assets/[assetId]/byteplus-trust/route.js';

const request = { cookies: { get: () => ({ value: 'session-token' }) } };
const context = { params: Promise.resolve({ assetId: 'asset-1' }) };

async function body(response) {
  return response.json();
}

test('trust GET and POST require authentication', async () => {
  const handlers = createBytePlusAssetTrustHandlers({
    resolveTenantContext: async () => { throw Object.assign(new Error('Authentication required'), { status: 401 }); },
    trustService: {
      async getTrust() { throw new Error('must not read trust'); },
      async startTrust() { throw new Error('must not start trust'); },
    },
  });

  for (const handler of [handlers.GET, handlers.POST]) {
    const response = await handler(request, context);
    assert.equal(response.status, 401);
    assert.deepEqual(await body(response), { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } });
  }
});

test('cross-workspace assets use not-found responses without disclosing mappings', async () => {
  const calls = [];
  const handlers = createBytePlusAssetTrustHandlers({
    resolveTenantContext: async () => ({ workspace: { id: 'workspace-1' } }),
    trustService: {
      async getTrust(...args) { calls.push(args); return null; },
      async startTrust(...args) { calls.push(args); return null; },
    },
  });

  for (const handler of [handlers.GET, handlers.POST]) {
    const response = await handler(request, { params: Promise.resolve({ assetId: 'outside-asset' }) });
    assert.equal(response.status, 404);
    assert.deepEqual(await body(response), { error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
  }
  assert.deepEqual(calls, [
    ['workspace-1', 'outside-asset'],
    ['workspace-1', 'outside-asset'],
  ]);
});

test('handlers use only the authenticated default workspace and return safe state', async () => {
  const calls = [];
  const handlers = createBytePlusAssetTrustHandlers({
    resolveTenantContext: async ({ token }) => {
      assert.equal(token, 'session-token');
      return { workspace: { id: 'workspace-authenticated' } };
    },
    trustService: {
      async getTrust(...args) { calls.push(['GET', ...args]); return { status: 'active' }; },
      async startTrust(...args) { calls.push(['POST', ...args]); return { status: 'processing' }; },
    },
  });

  const getResponse = await handlers.GET(request, context);
  const postResponse = await handlers.POST(request, context);
  assert.equal(getResponse.status, 200);
  assert.equal(postResponse.status, 200);
  assert.deepEqual(await body(getResponse), { status: 'active' });
  assert.deepEqual(await body(postResponse), { status: 'processing' });
  assert.deepEqual(calls, [
    ['GET', 'workspace-authenticated', 'asset-1'],
    ['POST', 'workspace-authenticated', 'asset-1'],
  ]);
});

test('route exposes only allowlisted safe errors from configuration and validation', async () => {
  const cases = [
    [new BytePlusAssetsError('BytePlus Assets API is not configured.', {
      code: 'BYTEPLUS_ASSETS_NOT_CONFIGURED', status: 503,
    }), 503, 'BYTEPLUS_ASSETS_NOT_CONFIGURED', 'BytePlus Assets API is not configured.'],
    [Object.assign(new Error('Image assets only'), {
      code: 'BYTEPLUS_ASSET_TYPE_UNSUPPORTED', status: 400, providerAssetId: 'provider-secret', providerBody: 'raw failure',
    }), 400, 'BYTEPLUS_ASSET_TYPE_UNSUPPORTED', 'Only image assets can be trusted for Seedance.'],
    [Object.assign(new Error('local://download?signature=provider-secret'), {
      code: 'BYTEPLUS_ASSET_SOURCE_UNAVAILABLE', status: 503,
    }), 503, 'BYTEPLUS_ASSET_SOURCE_UNAVAILABLE', 'Asset storage is not available to BytePlus.'],
  ];

  for (const [failure, status, code, message] of cases) {
    const handlers = createBytePlusAssetTrustHandlers({
      resolveTenantContext: async () => ({ workspace: { id: 'workspace-1' } }),
      trustService: {
        async getTrust() { throw failure; },
        async startTrust() { throw failure; },
      },
    });
    const response = await handlers.POST(request, context);
    const payload = await body(response);
    assert.equal(response.status, status);
    assert.deepEqual(payload, { error: { code, message } });
    assert.doesNotMatch(JSON.stringify(payload), /provider-secret|raw failure/);
  }
});

test('unexpected failures return a generic response without provider details', async () => {
  const handlers = createBytePlusAssetTrustHandlers({
    resolveTenantContext: async () => ({ workspace: { id: 'workspace-1' } }),
    trustService: {
      async getTrust() { throw new Error('provider id asset-secret and raw provider response'); },
      async startTrust() { throw new Error('provider id asset-secret and raw provider response'); },
    },
  });

  const response = await handlers.GET(request, context);
  assert.equal(response.status, 500);
  assert.deepEqual(await body(response), {
    error: { code: 'BYTEPLUS_ASSET_TRUST_FAILED', message: 'Unable to update trusted asset.' },
  });
});
