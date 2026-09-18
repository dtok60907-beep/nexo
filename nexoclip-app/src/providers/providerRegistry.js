const DIRECT_MODEL_MAP = new Map([
  ['google-imagen4', { provider: 'google', model: 'imagen-4.0-generate-001' }],
  ['google-imagen4-fast', { provider: 'google', model: 'imagen-4.0-fast-generate-001' }],
  ['google-imagen4-ultra', { provider: 'google', model: 'imagen-4.0-ultra-generate-001' }],
  ['dola-seedream-5-0-pro-260628', { provider: 'byteplus', model: 'dola-seedream-5-0-pro-260628' }],
  ['bytedance-seed/seedream-5-0-pro', { provider: 'byteplus', model: 'dola-seedream-5-0-pro-260628' }],
  ['bytedance-seed/seedream-4.5', { provider: 'byteplus', model: 'seedream-4-5-251128' }],
  ['seedream-5-0-260128', { provider: 'byteplus', model: 'seedream-5-0-260128' }],
  ['seedream-5-0-lite-260128', { provider: 'byteplus', model: 'seedream-5-0-260128' }],
  ['seedream-4-5-251128', { provider: 'byteplus', model: 'seedream-4-5-251128' }],
  ['seedream-4-0-250828', { provider: 'byteplus', model: 'seedream-4-0-250828' }],
  ['seedream-3.0-t2i', { provider: 'byteplus', model: 'seedream-3.0-t2i' }],
  // Dedicated unfiltered aliases resolved via env-backed endpoint IDs
  ['byteplus/seedance-2.0-unfiltered', { provider: 'byteplus', model: 'byteplus/seedance-2.0-unfiltered', endpointEnv: 'BYTEPLUS_SEEDANCE_2_ENDPOINT' }],
  ['byteplus/seedance-2.5-unfiltered', { provider: 'byteplus', model: 'byteplus/seedance-2.5-unfiltered', endpointEnv: 'BYTEPLUS_SEEDANCE_2_5_ENDPOINT' }],
  ['byteplus/seedream-5.0-pro-unfiltered', { provider: 'byteplus', model: 'byteplus/seedream-5.0-pro-unfiltered', endpointEnv: 'BYTEPLUS_SEEDREAM_5_ENDPOINT' }],
  ['ep-20260907150312-xx7gf', { provider: 'byteplus', model: 'ep-20260907150312-xx7gf' }],
  ['ep-20260907150433-zg8fr', { provider: 'byteplus', model: 'ep-20260907150433-zg8fr' }],
  ['ep-20260904190604-p8pjl', { provider: 'byteplus', model: 'ep-20260904190604-p8pjl' }],
  ['dreamina-seedance-2-5-260628', { provider: 'byteplus', model: 'dreamina-seedance-2-5-260628' }],
  ['bytedance/seedance-2.5', { provider: 'byteplus', model: 'dreamina-seedance-2-5-260628' }],
  ['dreamina-seedance-2-0-260128', { provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' }],
  ['dreamina-seedance-2-0-fast-260128', { provider: 'byteplus', model: 'dreamina-seedance-2-0-fast-260128' }],
  ['dreamina-seedance-2-0-mini-260615', { provider: 'byteplus', model: 'dreamina-seedance-2-0-mini-260615' }],
  ['seedance-1-5-pro-251215', { provider: 'byteplus', model: 'seedance-1-5-pro-251215' }],
  ['seedance-1-0-pro-250528', { provider: 'byteplus', model: 'seedance-1-0-pro-250528' }],
  ['seedance-1-0-pro-fast-251015', { provider: 'byteplus', model: 'seedance-1-0-pro-fast-251015' }],
  ['seedance-v2.0-t2v', { provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' }],
  ['seedance-v2.0-i2v', { provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' }],
  ['seedance-v2.0-extend', { provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' }],
  ['bytedance/seedance-2.0', { provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' }],
  ['bytedance/seedance-2.0-mini', { provider: 'byteplus', model: 'dreamina-seedance-2-0-mini-260615' }],
  ['openai/gpt-5-image', { provider: 'openai', model: 'gpt-image-1' }],
  ['openai/gpt-5-image-mini', { provider: 'openai', model: 'gpt-image-1-mini' }],
  ['openai/gpt-5.4-image-2', { provider: 'openai', model: 'gpt-image-2' }],
  // OpenRouter only carries Sora 2 Pro (no plain/standard Sora tiers) and — as of this
  // writing — rejects it outright (403) regardless of whether an image reference is
  // attached, so this always falls through to OpenAI's own Video API.
  ['openai/sora-2-pro', { provider: 'openai', model: 'sora-2-pro' }],
]);

const DIRECT_BYTEPLUS_SEEDANCE_MODELS = new Set([
  'byteplus/seedance-2.0-unfiltered',
  'byteplus/seedance-2.5-unfiltered',
  'ep-20260904190604-p8pjl',
  'dreamina-seedance-2-5-260628',
  'bytedance/seedance-2.5',
  'dreamina-seedance-2-0-260128',
  'dreamina-seedance-2-0-fast-260128',
  'dreamina-seedance-2-0-mini-260615',
  'seedance-1-5-pro-251215',
  'seedance-1-0-pro-250528',
  'seedance-1-0-pro-fast-251015',
  'seedance-v2.0-t2v',
  'seedance-v2.0-i2v',
  'seedance-v2.0-extend',
  'bytedance/seedance-2.0',
  'bytedance/seedance-2.0-mini',
]);

const DIRECT_PREFIXES = [
  ['google/', 'google'],
  ['gemini-', 'google'],
  ['imagen-', 'google'], 
  ['byteplus/', 'byteplus'],
  ['gpt-image-', 'openai'],
  ['openai/gpt-image-', 'openai'],
];

export function getDirectProvider(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const normalized = model.trim();
  const mapped = DIRECT_MODEL_MAP.get(normalized);
  if (mapped) return { ...mapped };
  const prefix = DIRECT_PREFIXES.find(([value]) => normalized.toLowerCase().startsWith(value));
  if (!prefix) return null;
  // OpenRouter-namespaced prefixes ('google/', 'openai/gpt-image-') strip the vendor namespace;
  // bare prefixes ('gpt-image-') already match the direct provider's own model name as-is.
  const namespaceEnd = prefix[0].indexOf('/');
  const directModel = namespaceEnd === -1 ? normalized : normalized.slice(namespaceEnd + 1);
  return { provider: prefix[1], model: directModel };
}

export function createBytePlusEndpointNotConfiguredError(model, endpointEnv) {
  return Object.assign(
    new Error(`BytePlus endpoint for ${model} is not configured`),
    { code: 'BYTEPLUS_ENDPOINT_NOT_CONFIGURED', status: 503, model, endpointEnv },
  );
}

export function resolveDirectProviderModel(mapping, env = process.env) {
  if (!mapping?.endpointEnv) return mapping?.model;
  const endpoint = env[mapping.endpointEnv]?.trim();
  if (!endpoint) throw createBytePlusEndpointNotConfiguredError(mapping.model, mapping.endpointEnv);
  return endpoint;
}

export function isDirectBytePlusSeedance(model, env = process.env) {
  if (typeof model !== 'string' || !DIRECT_BYTEPLUS_SEEDANCE_MODELS.has(model.trim())) return false;
  const mapping = getDirectProvider(model);
  if (mapping?.provider !== 'byteplus') return false;
  resolveDirectProviderModel(mapping, env);
  return true;
}

export function isRetryableProviderError(error) {
  const status = Number(error?.status);
  if (status === 403 && error?.code === 'OPENROUTER_AUTHORIZATION_FAILED') return true;
  // OpenRouter returns 400 when it has no route for a model it doesn't carry;
  // that's a routing gap, not a malformed request, so a mapped direct provider may still serve it.
  if (status === 400 && error?.code === 'OPENROUTER_MODEL_UNAVAILABLE') return true;
  if (status) return [408, 409, 429].includes(status) || status >= 500;
  return error instanceof TypeError || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET';
}

export function createDirectProviderUnavailableError(model, provider) {
  const label = provider || 'the model owner';
  return Object.assign(new Error(`Model ${model} has no configured fallback direct provider (${label})`), { code: 'DIRECT_PROVIDER_UNAVAILABLE', status: 503, model, provider: provider || null });
}
