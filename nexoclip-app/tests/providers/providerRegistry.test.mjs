import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDirectProvider,
  resolveDirectProviderModel,
  createBytePlusEndpointNotConfiguredError,
  isDirectBytePlusSeedance,
  isRetryableProviderError,
  createDirectProviderUnavailableError,
} from '../../src/providers/providerRegistry.js';

test('maps supported generator model IDs to direct providers', () => {
  assert.deepEqual(getDirectProvider('google-imagen4'), { provider: 'google', model: 'imagen-4.0-generate-001' });
  assert.deepEqual(getDirectProvider('google-imagen4-fast'), { provider: 'google', model: 'imagen-4.0-fast-generate-001' });
  assert.deepEqual(getDirectProvider('gpt-image-1.5'), { provider: 'openai', model: 'gpt-image-1.5' });
  assert.deepEqual(getDirectProvider('seedance-v2.0-t2v'), { provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' });
  assert.deepEqual(getDirectProvider('byteplus/seedream-4-5-251128'), { provider: 'byteplus', model: 'seedream-4-5-251128' });
  assert.deepEqual(getDirectProvider('gemini-2.5-flash-image'), { provider: 'google', model: 'gemini-2.5-flash-image' });
  assert.equal(getDirectProvider('flux-2-pro'), null);
});

test('only classifies transient failures as retryable', () => {
  for (const status of [408, 409, 429, 500, 502, 503, 504]) assert.equal(isRetryableProviderError({ status }), true);
  assert.equal(isRetryableProviderError({ status: 401 }), false);
  assert.equal(isRetryableProviderError({ status: 400 }), false);
  assert.equal(isRetryableProviderError(new TypeError('fetch failed')), true);
});

test('creates safe unsupported direct provider error', () => {
  const error = createDirectProviderUnavailableError('unknown/model', null);
  assert.equal(error.code, 'DIRECT_PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.model, 'unknown/model');
  assert.match(error.message, /fallback direct provider/i);
});

test('maps dedicated BytePlus aliases to environment-backed endpoints', () => {
  const mapping = getDirectProvider('byteplus/seedance-2.0-unfiltered');
  assert.deepEqual(mapping, {
    provider: 'byteplus',
    model: 'byteplus/seedance-2.0-unfiltered',
    endpointEnv: 'BYTEPLUS_SEEDANCE_2_ENDPOINT',
  });
  assert.equal(resolveDirectProviderModel(mapping, {
    BYTEPLUS_SEEDANCE_2_ENDPOINT: ' ep-20260916130459-fw94z ',
  }), 'ep-20260916130459-fw94z');
});

test('fails closed when a dedicated BytePlus endpoint is not configured', () => {
  const mapping = getDirectProvider('byteplus/seedance-2.5-unfiltered');
  assert.throws(
    () => resolveDirectProviderModel(mapping, {}),
    (error) => error.code === 'BYTEPLUS_ENDPOINT_NOT_CONFIGURED'
      && error.status === 503
      && error.endpointEnv === 'BYTEPLUS_SEEDANCE_2_5_ENDPOINT',
  );
});

test('keeps standard BytePlus models on base model ids', () => {
  const mapping = getDirectProvider('dreamina-seedance-2-0-260128');
  assert.equal(mapping.endpointEnv, undefined);
  assert.equal(resolveDirectProviderModel(mapping, {}), 'dreamina-seedance-2-0-260128');
});

test('classifies only registered Seedance models and configured aliases', () => {
  assert.equal(isDirectBytePlusSeedance('bytedance/seedance-2.5', {}), true);
  assert.equal(isDirectBytePlusSeedance('ep-20260904190604-p8pjl', {}), true);
  assert.equal(isDirectBytePlusSeedance('byteplus/seedance-2.5-unfiltered', {
    BYTEPLUS_SEEDANCE_2_5_ENDPOINT: 'ep-private',
  }), true);
  assert.equal(isDirectBytePlusSeedance('byteplus/seedance-future', {}), false);
  assert.equal(isDirectBytePlusSeedance('byteplus/not-a-registered-model', {}), false);
});
