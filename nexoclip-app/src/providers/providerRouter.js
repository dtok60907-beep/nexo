import { createOpenRouterImageAdapter } from './openrouter/imageAdapter.js';
import { createOpenRouterVideoAdapter } from './openrouter/videoAdapter.js';
import { createOpenAIImageAdapter } from './direct/imageAdapters.js';
import { createGoogleImageAdapter } from './direct/imageAdapters.js';
import { createBytePlusImageAdapter } from './direct/imageAdapters.js';
import { createBytePlusAdapter } from './direct/byteplusAdapter.js';
import { createOpenAIVideoAdapter } from './direct/openaiVideoAdapter.js';
import { getDirectProvider, resolveDirectProviderModel, isDirectBytePlusSeedance, isRetryableProviderError, createDirectProviderUnavailableError } from './providerRegistry.js';

const TRUSTED_ASSET_REQUEST = Symbol('trustedBytePlusAssetRequest');

export function markTrustedAssetRequest(params) {
  Object.defineProperty(params, TRUSTED_ASSET_REQUEST, { value: true });
  return params;
}

export function isTrustedAssetRequest(params) {
  return params?.[TRUSTED_ASSET_REQUEST] === true;
}

function hasAssetUri(params) {
  const urls = [
    ...(params?.referenceImages || []),
    ...(params?.frameImages || []).map((frame) => frame?.image_url?.url),
  ];
  return urls.some((url) => typeof url === 'string' && url.trim().toLowerCase().startsWith('asset://'));
}

function directConfigured(env, provider) {
  if (provider === 'google') return Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  if (provider === 'openai') return Boolean(env.OPENAI_API_KEY);
  if (provider === 'byteplus') return Boolean(env.BYTEPLUS_API_KEY && env.BYTEPLUS_BASE_URL);
  return false;
}

// BytePlus's task status vocabulary ('succeeded'/'running'/'queued'/'failed') doesn't match
// the OpenRouter vocabulary ('completed'/'failed'/'cancelled'/'expired') that the video poll
// route checks against — an un-normalized 'succeeded' never satisfies `status !== 'completed'`,
// so a BytePlus job would poll as "running" forever even after it actually finished.
function normalizeBytePlusStatus(status) {
  if (status?.status === 'succeeded') return { ...status, status: 'completed' };
  if (status?.error && typeof status.error === 'object') {
    return { ...status, error: status.error.message || status.error.code || 'BytePlus generation failed', error_code: status.error.code };
  }
  return status;
}

function directAdapter(env, provider, operation, fetchImpl) {
  if (operation === 'image' && provider === 'google') return createGoogleImageAdapter({ apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, fetch: fetchImpl });
  if (operation === 'image' && provider === 'openai') return createOpenAIImageAdapter({ apiKey: env.OPENAI_API_KEY, fetch: fetchImpl });
  if (operation === 'image' && provider === 'byteplus') return createBytePlusImageAdapter({ apiKey: env.BYTEPLUS_API_KEY, baseUrl: env.BYTEPLUS_BASE_URL, fetch: fetchImpl });
  if (operation === 'video' && provider === 'byteplus') return createBytePlusAdapter({ apiKey: env.BYTEPLUS_API_KEY, baseUrl: env.BYTEPLUS_BASE_URL, fetch: fetchImpl });
  if (operation === 'video' && provider === 'openai') return createOpenAIVideoAdapter({ apiKey: env.OPENAI_API_KEY, fetch: fetchImpl });
  return null;
}

export function createProviderRouter({ env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const openrouterImage = () => createOpenRouterImageAdapter({ apiKey: env.OPENROUTER_API_KEY, fetch: fetchImpl });
  const openrouterVideo = () => createOpenRouterVideoAdapter({ apiKey: env.OPENROUTER_API_KEY, fetch: fetchImpl });

  async function withFallback(operation, params, primary) {
    try { return await primary(); } catch (error) {
      const mapping = getDirectProvider(params.model);
      // OpenRouter's 400 wording for "I don't carry this model" isn't a stable contract to pattern-match,
      // so any 400 is treated as a routing gap (not a malformed request) once the model is already on the
      // explicit direct-fallback allowlist below. Unmapped models still hard-fail on 400 as before.
      // 402 (insufficient OpenRouter account credits) is an OpenRouter-side capacity problem, not a
      // problem with this request, so it gets the same treatment for mapped models.
      const retryable = isRetryableProviderError(error) || (mapping && [400, 402, 404].includes(Number(error?.status)));
      if (!retryable) throw error;
      // Models outside the explicit direct-fallback allowlist remain OpenRouter-only.
      if (!mapping) throw error;
      if (!directConfigured(env, mapping.provider)) {
        throw createDirectProviderUnavailableError(params.model, mapping.provider);
      }
      const adapter = directAdapter(env, mapping.provider, operation, fetchImpl);
      if (!adapter) throw createDirectProviderUnavailableError(params.model, mapping.provider);
      const directModel = resolveDirectProviderModel(mapping, env);
      const result = operation === 'image' ? await adapter.generate({ ...params, model: directModel }) : await adapter.submit({ ...params, model: directModel });
      return { ...result, provider: mapping.provider };
    }
  }

  async function run(operation, params, primary) {
    if (operation === 'video' && hasAssetUri(params) && !isTrustedAssetRequest(params)) {
      throw Object.assign(new Error('Provider asset references must be resolved by the workspace service'), {
        code: 'INVALID_REFERENCE_IMAGE', status: 400,
      });
    }
    const mapping = getDirectProvider(params.model);
    // BytePlus endpoint IDs are deployment-specific and are not valid OpenRouter model IDs.
    // Dedicated aliases with endpointEnv must resolve to endpoint IDs and route directly as well.
    const hasDirectOnlyAsset = operation === 'video'
      && isTrustedAssetRequest(params)
      && isDirectBytePlusSeedance(params.model, env);
    if (mapping?.provider === 'byteplus' && (mapping.endpointEnv || params.model.startsWith('ep-') || hasDirectOnlyAsset)) {
      if (!directConfigured(env, 'byteplus')) throw createDirectProviderUnavailableError(params.model, 'byteplus');
      const adapter = directAdapter(env, 'byteplus', operation, fetchImpl);
      const directModel = resolveDirectProviderModel(mapping, env);
      const directParams = { ...params, model: directModel };
      return operation === 'image' ? adapter.generate(directParams) : adapter.submit(directParams);
    }
    return withFallback(operation, params, primary);
  }

  return {
    generateImage: (params) => run('image', params, () => openrouterImage().generate(params)),
    submitVideo: (params) => run('video', params, () => openrouterVideo().submit(params)),
    pollVideo: async (provider, id) => {
      if (provider === 'openrouter') return openrouterVideo().poll(id);
      const status = await directAdapter(env, provider, 'video', fetchImpl).poll(id);
      // Direct providers each speak their own status vocabulary; only BytePlus's diverges
      // from the 'completed'/'failed' contract the video poll route checks against.
      return provider === 'byteplus' ? normalizeBytePlusStatus(status) : status;
    },
    downloadVideo: (provider, id, index = 0) => provider === 'openrouter' ? openrouterVideo().downloadContent(id, index) : directAdapter(env, provider, 'video', fetchImpl).downloadContent(id, index),
  };
}
