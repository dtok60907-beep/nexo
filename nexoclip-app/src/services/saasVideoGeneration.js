import { randomUUID } from 'node:crypto';
import { findExactTrustedWorkspaceAsset } from './assetService.js';
import { createProviderRouter, markTrustedAssetRequest } from '../providers/providerRouter.js';
import { createGeneratedAsset } from '../repositories/assetMetadataRepository.js';
import { findBytePlusAssetLink as findStoredBytePlusAssetLink } from '../repositories/byteplusAssetRepository.js';
import { isDirectBytePlusSeedance } from '../providers/providerRegistry.js';
import { resolveReferenceImages } from './saasImageGeneration.js';

const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'expired']);

function trustedAssetError(status) {
  if (status === 'processing') {
    return Object.assign(new Error('Trusted BytePlus asset is still processing. Wait for Trust for Seedance to become active.'), {
      code: 'BYTEPLUS_ASSET_PROCESSING', status: 409, retryable: true,
    });
  }
  if (status === 'failed') {
    return Object.assign(new Error('Trusted BytePlus asset failed processing. Retry Trust for Seedance before generating.'), {
      code: 'BYTEPLUS_ASSET_FAILED', status: 422,
    });
  }
  return Object.assign(new Error('Trusted BytePlus asset mapping is invalid. Retry Trust for Seedance before generating.'), {
    code: 'BYTEPLUS_ASSET_INVALID', status: 422,
  });
}

function videoRequest(job, { referenceImages, frameImages, referenceVideos }) {
  const parameters = job.parameters || {};
  const framed = frameImages.map((url, index) => ({
    type: 'image_url', image_url: { url }, frame_type: parameters.frameImages[index].frameType,
  }));
  return {
    model: job.model, prompt: job.prompt,
    ...(parameters.duration !== undefined ? { duration: Number(parameters.duration) } : {}),
    ...(parameters.resolution ? { resolution: parameters.resolution } : {}),
    ...(parameters.aspectRatio ? { aspectRatio: parameters.aspectRatio } : {}),
    ...(parameters.seed !== undefined ? { seed: parameters.seed } : {}),
    ...(framed.length ? { frameImages: framed } : {}),
    ...(referenceImages.length ? { referenceImages } : {}),
    ...(referenceVideos.length ? { referenceVideos } : {}),
  };
}

export function createSaasVideoHandler({ pool, storage, referenceStorage = storage, providerRouter, findBytePlusAssetLink = findStoredBytePlusAssetLink, findExactTrustedAsset = findExactTrustedWorkspaceAsset, env = process.env, createAsset = createGeneratedAsset, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollIntervalMs = 5_000, maxPolls = 120 }) {
  if (!pool || !storage || !providerRouter) throw new TypeError('pool, storage, and provider router are required');
  return async (job) => {
    let hasTrustedAsset = false;
    const deferredTrustedAssetErrors = new Map();
    const projectName = env.BYTEPLUS_PROJECT_NAME?.trim() || 'default';
    const resolveWorkspaceAsset = isDirectBytePlusSeedance(job.model, env)
      ? async ({ workspaceId, assetId }) => {
        const link = await findBytePlusAssetLink(pool, workspaceId, assetId);
        if (!link) return null;
        if (link.project_name !== projectName) {
          throw Object.assign(new Error('Trusted BytePlus asset belongs to another project. Recreate Trust for Seedance.'), {
            code: 'BYTEPLUS_ASSET_PROJECT_MISMATCH', status: 422,
          });
        }
        if (link.status === 'active' && link.provider_asset_id?.trim()) {
          hasTrustedAsset = true;
          return `asset://${link.provider_asset_id.trim()}`;
        }
        // A duplicate may have a newer Trust attempt still processing while an
        // identical older asset is already active. Let byte-exact recovery run
        // before surfacing this mapping's actionable error.
        deferredTrustedAssetErrors.set(assetId, trustedAssetError(link.status));
        return null;
      }
      : undefined;
    const resolveWorkspaceAssetContent = resolveWorkspaceAsset
      ? async ({ workspaceId, assetId, body, contentType }) => {
        const match = await findExactTrustedAsset({
          workspaceId, body, contentType, excludeAssetId: assetId, projectName,
        }, storage, pool);
        if (match?.provider_asset_id?.trim()) {
          hasTrustedAsset = true;
          return `asset://${match.provider_asset_id.trim()}`;
        }
        const deferredError = deferredTrustedAssetErrors.get(assetId);
        if (deferredError) throw deferredError;
        return null;
      }
      : undefined;
    const resolution = { workspaceId: job.workspace_id, pool, storage, referenceStorage, resolveWorkspaceAsset, resolveWorkspaceAssetContent };
    const referenceImages = await resolveReferenceImages({ ...resolution, referenceImages: job.parameters?.referenceImages });
    const frameImages = await resolveReferenceImages({ ...resolution, referenceImages: (job.parameters?.frameImages || []).map((frame) => frame.url) });
    const referenceVideos = await resolveReferenceImages({ workspaceId: job.workspace_id, referenceImages: job.parameters?.referenceVideos, pool, storage, referenceStorage });
    if (isDirectBytePlusSeedance(job.model, env)) {
      const rawReference = [...referenceImages, ...frameImages, ...referenceVideos]
        .find((reference) => !reference.startsWith('asset://'));
      if (rawReference) {
        throw Object.assign(new Error('Every Seedance reference must be an active Trusted Asset. Import it into Assets and use Trust for Seedance before generating.'), {
          code: 'BYTEPLUS_REFERENCE_NOT_TRUSTED', status: 422,
        });
      }
    }
    const request = videoRequest(job, { referenceImages, frameImages, referenceVideos });
    const submitted = await providerRouter.submitVideo(hasTrustedAsset ? markTrustedAssetRequest(request) : request);
    const provider = submitted.provider || 'openrouter';
    const providerRequestId = submitted.id || submitted.providerRequestId;
    if (!providerRequestId) throw Object.assign(new Error('Provider returned no video request id'), { code: 'PROVIDER_INVALID_RESPONSE' });
    let status;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      status = await providerRouter.pollVideo(provider, providerRequestId);
      if (status?.status === 'completed') break;
      if (TERMINAL_FAILURES.has(status?.status)) throw Object.assign(new Error('Video provider generation failed'), { code: 'PROVIDER_GENERATION_FAILED' });
      await sleep(pollIntervalMs);
    }
    if (status?.status !== 'completed') throw Object.assign(new Error('Video provider generation timed out'), { code: 'GENERATION_TIMEOUT' });
    const output = await providerRouter.downloadVideo(provider, providerRequestId, 0);
    const key = `${job.workspace_id}/${randomUUID()}`;
    const contentType = output.contentType || 'video/mp4';
    if (typeof storage.createUploadUrl === 'function') {
      const upload = await storage.createUploadUrl({ key, contentType });
      await storage.put(upload.url || upload, output.buffer, contentType);
    } else {
      await storage.put(key, output.buffer, contentType);
    }
    const client = await pool.connect();
    try {
      const asset = await createAsset(client, { workspaceId: job.workspace_id, storageKey: key, filename: `generation-${job.id}.mp4`, contentType, sizeBytes: output.buffer.length });
      return { status: 'succeeded', provider, providerRequestId, outputs: [{ assetId: asset.id }], usage: submitted.usage || {} };
    } finally { client.release(); }
  };
}

export function createDefaultSaasVideoHandler({ pool, storage, referenceStorage = storage, providerRouter = createProviderRouter(), findBytePlusAssetLink = findStoredBytePlusAssetLink, env = process.env }) {
  return createSaasVideoHandler({ pool, storage, referenceStorage, providerRouter, findBytePlusAssetLink, env });
}
