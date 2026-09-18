import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BytePlusAssetsError,
  createBytePlusAssetsClient,
  isBytePlusAssetNotFound,
  mapBytePlusAssetStatus,
} from '../../src/providers/byteplusAssetsClient.js';

const env = {
  BYTEPLUS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  BYTEPLUS_SECRET_ACCESS_KEY: 'secret-key-value',
  BYTEPLUS_PROJECT_NAME: 'project-x',
};
const fixedNow = () => new Date('2026-09-16T12:34:56.000Z');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function recordingClient(result = { Result: { Id: 'result-1' } }) {
  const calls = [];
  const client = createBytePlusAssetsClient({
    env,
    now: fixedNow,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(result);
    },
  });
  return { client, calls };
}

test('requires both Assets API credentials without exposing the configured credential', () => {
  assert.throws(
    () => createBytePlusAssetsClient({ env: { BYTEPLUS_ACCESS_KEY_ID: 'do-not-leak' } }),
    (error) => {
      assert.ok(error instanceof BytePlusAssetsError);
      assert.equal(error.code, 'BYTEPLUS_ASSETS_NOT_CONFIGURED');
      assert.equal(error.status, 503);
      assert.equal(error.message, 'BytePlus Assets API is not configured.');
      assert.doesNotMatch(JSON.stringify(error), /do-not-leak/);
      return true;
    },
  );
});

test('exposes only the three focused Assets API operations', () => {
  const { client } = recordingClient();
  assert.deepEqual(Object.keys(client).sort(), ['createAsset', 'createAssetGroup', 'deleteAsset', 'getAsset']);
});

test('rejects empty required inputs locally with a safe non-retryable error', () => {
  let sideEffects = 0;
  const client = createBytePlusAssetsClient({
    env,
    now: () => {
      sideEffects += 1;
      return fixedNow();
    },
    fetchFn: async () => {
      sideEffects += 1;
      return jsonResponse({ Result: {} });
    },
  });
  const invalidCalls = [
    () => client.createAssetGroup({ name: ' ' }),
    () => client.createAsset({ groupId: '', url: 'https://objects.example/source.png', name: 'Character' }),
    () => client.createAsset({ groupId: 'group-1', url: ' ', name: 'Character' }),
    () => client.createAsset({ groupId: 'group-1', url: 'https://objects.example/source.png', name: undefined }),
    () => client.createAssetGroup({ name: 'Character', clientToken: ' ' }),
    () => client.createAsset({ groupId: 'group-1', url: 'https://objects.example/source.png', name: 'Character', clientToken: '' }),
    () => client.getAsset({ assetId: '' }),
    () => client.deleteAsset({ assetId: '', projectName: 'project-x' }),
  ];

  for (const call of invalidCalls) {
    assert.throws(call, (error) => {
      assert.ok(error instanceof BytePlusAssetsError);
      assert.equal(error.code, 'BYTEPLUS_ASSETS_INVALID_INPUT');
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.equal(error.message, 'BytePlus Assets API input is invalid.');
      assert.doesNotMatch(JSON.stringify(error), /objects\.example|Character/);
      return true;
    });
  }
  assert.equal(sideEffects, 0);
});

test('signs CreateAssetGroup and sends the provider idempotency token', async () => {
  const { client, calls } = recordingClient({ Result: { Id: 'group-1' } });

  const result = await client.createAssetGroup({
    name: 'Portrait', description: 'Canvas asset', clientToken: 'server-derived-group-token',
  });

  assert.deepEqual(result, { Id: 'group-1' });
  assert.equal(calls[0].url, 'https://ark.ap-southeast-1.byteplusapi.com/?Action=CreateAssetGroup&Version=2024-01-01');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    Name: 'Portrait',
    Description: 'Canvas asset',
    GroupType: 'AIGC',
    ProjectName: 'project-x',
    ClientToken: 'server-derived-group-token',
  });
  assert.match(calls[0].options.headers.Authorization, /Signature=[a-f0-9]{64}$/);
});

test('signs CreateAsset and enforces image and moderation body semantics', async () => {
  const { client, calls } = recordingClient({ Result: { Id: 'asset-1' } });

  const result = await client.createAsset({
    groupId: 'group-1',
    url: 'https://objects.example/source.png?token=short',
    name: 'Character',
    clientToken: 'server-derived-asset-token',
  });

  assert.deepEqual(result, { Id: 'asset-1' });
  assert.equal(calls[0].url, 'https://ark.ap-southeast-1.byteplusapi.com/?Action=CreateAsset&Version=2024-01-01');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    GroupId: 'group-1',
    URL: 'https://objects.example/source.png?token=short',
    Name: 'Character',
    AssetType: 'Image',
    Moderation: { Strategy: 'Skip' },
    ProjectName: 'project-x',
    ClientToken: 'server-derived-asset-token',
  });
  assert.match(calls[0].options.headers.Authorization, /Signature=[a-f0-9]{64}$/);
});

test('signs GetAsset and sends only the asset and project identifiers', async () => {
  const payload = { Result: { Id: 'asset-1', Status: 'Processing' } };
  const { client, calls } = recordingClient(payload);

  const result = await client.getAsset({ assetId: 'asset-1' });

  assert.deepEqual(result, payload.Result);
  assert.equal(calls[0].url, 'https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset&Version=2024-01-01');
  assert.equal(calls[0].options.body, '{"Id":"asset-1","ProjectName":"project-x"}');
  assert.equal(calls[0].options.headers.Authorization, 'HMAC-SHA256 Credential=AKIDEXAMPLE/20260916/ap-southeast-1/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=306556bb6bbd5c0637327f62167dbe6d5fd16cce65a380c85a7e256d9f330ebd');
});

test('signs DeleteAsset with the asset and project identifiers', async () => {
  const { client, calls } = recordingClient({ Result: { Id: 'asset-1' } });

  const result = await client.deleteAsset({ assetId: 'asset-1', projectName: 'trusted-project' });

  assert.deepEqual(result, { Id: 'asset-1' });
  assert.equal(calls[0].url, 'https://ark.ap-southeast-1.byteplusapi.com/?Action=DeleteAsset&Version=2024-01-01');
  assert.equal(calls[0].options.body, '{"Id":"asset-1","ProjectName":"trusted-project"}');
  assert.match(calls[0].options.headers.Authorization, /Signature=[a-f0-9]{64}$/);
});

test('classifies only typed BytePlus asset-not-found failures', async () => {
  const client = createBytePlusAssetsClient({
    env,
    now: fixedNow,
    fetchFn: async () => jsonResponse({
      ResponseMetadata: { Error: { Code: 'AssetNotFound', Message: 'provider details must not escape' } },
    }, 404),
  });

  await assert.rejects(client.deleteAsset({ assetId: 'asset-1', projectName: 'project-x' }), (error) => {
    assert.equal(error.code, 'AssetNotFound');
    assert.equal(error.status, 404);
    assert.equal(error.retryable, false);
    assert.ok(isBytePlusAssetNotFound(error));
    assert.doesNotMatch(JSON.stringify(error), /provider details/);
    return true;
  });
  assert.equal(isBytePlusAssetNotFound(new Error('AssetNotFound')), false);
});

test('preserves retryable status for DeleteAsset rate limits and server failures', async () => {
  for (const status of [429, 500]) {
    const client = createBytePlusAssetsClient({
      env,
      now: fixedNow,
      fetchFn: async () => jsonResponse({ Result: {} }, status),
    });

    await assert.rejects(client.deleteAsset({ assetId: 'asset-1', projectName: 'project-x' }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.retryable, true);
      assert.equal(error.code, 'BYTEPLUS_ASSETS_UNAVAILABLE');
      return true;
    });
  }
});

test('uses the documented default project and configured region', async () => {
  const calls = [];
  const client = createBytePlusAssetsClient({
    env: {
      BYTEPLUS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      BYTEPLUS_SECRET_ACCESS_KEY: 'secret-key-value',
      BYTEPLUS_REGION: 'eu-central-1',
    },
    now: fixedNow,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ Result: { Id: 'group-1' } });
    },
  });

  await client.createAssetGroup({ name: 'Portrait', clientToken: 'server-token' });

  assert.match(calls[0].url, /^https:\/\/ark\.eu-central-1\.byteplusapi\.com\//);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    Name: 'Portrait',
    GroupType: 'AIGC',
    ProjectName: 'default',
    ClientToken: 'server-token',
  });
  assert.match(calls[0].options.headers.Authorization, /\/eu-central-1\/ark\/request/);
});

test('maps only allowlisted provider statuses and rejects missing or unknown values', () => {
  assert.deepEqual(mapBytePlusAssetStatus({ Result: { Status: 'Active' } }), { status: 'active' });
  assert.deepEqual(
    mapBytePlusAssetStatus({ Result: { Status: 'Failed', Error: { Code: 'SensitiveCode', Message: 'internal provider detail' } } }),
    { status: 'failed', error: { code: 'BYTEPLUS_ASSET_PROCESSING_FAILED', message: 'BytePlus could not process this asset.' } },
  );
  for (const status of ['Processing', 'Queued', 'Pending']) {
    assert.deepEqual(mapBytePlusAssetStatus({ Result: { Status: status } }), { status: 'processing' });
  }
  for (const status of [undefined, '', 'Mystery']) {
    assert.throws(
      () => mapBytePlusAssetStatus({ Result: { Status: status } }),
      (error) => error.code === 'BYTEPLUS_ASSETS_INVALID_RESPONSE' && error.status === 502,
    );
  }
});

test('bounds provider network calls with an abort timeout', async () => {
  const { client, calls } = recordingClient();
  await client.getAsset({ assetId: 'asset-1' });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('returns retryable typed errors for transport and transient HTTP failures', async () => {
  const transportClient = createBytePlusAssetsClient({
    env,
    now: fixedNow,
    fetchFn: async () => { throw new TypeError('fetch failed with secret-key-value'); },
  });
  const transientClient = createBytePlusAssetsClient({
    env,
    now: fixedNow,
    fetchFn: async () => jsonResponse({ ResponseMetadata: { Error: { Message: 'AKIDEXAMPLE secret-key-value' } } }, 429),
  });

  for (const [promise, status] of [
    [transportClient.getAsset({ assetId: 'asset-1' }), 503],
    [transientClient.getAsset({ assetId: 'asset-1' }), 429],
  ]) {
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof BytePlusAssetsError);
      assert.equal(error.code, 'BYTEPLUS_ASSETS_UNAVAILABLE');
      assert.equal(error.status, status);
      assert.equal(error.retryable, true);
      assert.equal(error.message, 'BytePlus Assets API is temporarily unavailable.');
      assert.doesNotMatch(JSON.stringify(error), /AKIDEXAMPLE|secret-key-value/);
      return true;
    });
  }
});

test('maps allowlisted transient HTTP 200 error envelopes to safe retryable failures', async () => {
  for (const code of ['Throttling', 'RequestLimitExceeded', 'InternalError', 'ServiceUnavailable']) {
    const client = createBytePlusAssetsClient({
      env,
      now: fixedNow,
      fetchFn: async () => jsonResponse({
        ResponseMetadata: { Error: { Code: code, Message: `sensitive ${code} provider body` } },
      }),
    });

    await assert.rejects(client.getAsset({ assetId: 'asset-1' }), (error) => {
      assert.ok(error instanceof BytePlusAssetsError);
      assert.equal(error.code, 'BYTEPLUS_ASSETS_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.message, 'BytePlus Assets API is temporarily unavailable.');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(`${code}|sensitive|provider body`));
      return true;
    });
  }
});

test('turns malformed success payloads into safe typed errors', async () => {
  const client = createBytePlusAssetsClient({
    env,
    now: fixedNow,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('secret-key-value'); } }),
  });

  await assert.rejects(client.getAsset({ assetId: 'asset-1' }), (error) => {
    assert.ok(error instanceof BytePlusAssetsError);
    assert.equal(error.code, 'BYTEPLUS_ASSETS_INVALID_RESPONSE');
    assert.equal(error.status, 502);
    assert.equal(error.message, 'BytePlus Assets API returned an invalid response.');
    assert.doesNotMatch(JSON.stringify(error), /secret-key-value/);
    return true;
  });
});

test('turns non-transient provider failures into credential-free typed errors', async () => {
  const responses = [
    jsonResponse({ ResponseMetadata: { Error: { Message: 'AKIDEXAMPLE secret-key-value' } } }, 400),
    jsonResponse({ ResponseMetadata: { Error: { Code: 'InvalidParameter', Message: 'AKIDEXAMPLE secret-key-value' } } }),
  ];

  for (const response of responses) {
    const client = createBytePlusAssetsClient({ env, now: fixedNow, fetchFn: async () => response });
    await assert.rejects(client.createAssetGroup({ name: 'Portrait', clientToken: 'server-token' }), (error) => {
      assert.ok(error instanceof BytePlusAssetsError);
      assert.equal(error.code, 'BYTEPLUS_ASSETS_REQUEST_FAILED');
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.equal(error.message, 'BytePlus Assets API request failed.');
      assert.doesNotMatch(JSON.stringify(error), /AKIDEXAMPLE|secret-key-value/);
      return true;
    });
  }
});
