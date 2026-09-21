import { createHash, randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import {
  compareAndSetBytePlusAssetLinkStatus,
  createProcessingBytePlusAssetLink,
  findBytePlusAssetLink,
  markBytePlusAssetLinkStale,
  resetBytePlusAssetLink,
  updateBytePlusAssetLink,
} from '../repositories/byteplusAssetRepository.js';
import {
  BytePlusAssetsError,
  createBytePlusAssetsClient,
  isBytePlusAssetNotFound,
  mapBytePlusAssetStatus,
} from '../providers/byteplusAssetsClient.js';
import { createStorage } from './assetService.js';

const SOURCE_URL_TTL_SECONDS = 300;
const PROCESSING_FAILURE = {
  code: 'BYTEPLUS_ASSET_PROCESSING_FAILED',
  message: 'BytePlus could not process this asset.',
};
const INVALID_STATE_FAILURE = {
  code: 'BYTEPLUS_ASSET_INVALID_STATE',
  message: 'Trusted asset is unavailable. Retry trust.',
};
const PROJECT_MISMATCH_FAILURE = {
  code: 'BYTEPLUS_ASSET_PROJECT_MISMATCH',
  message: 'Trusted asset belongs to another BytePlus project. Recreate trust.',
};
const CLAIM_STALE_MS = 30_000;
const SHARED_GROUP_NAME = 'NexoClip trusted assets';
const SHARED_GROUP_DESCRIPTION = 'Shared NexoClip BytePlus asset group';

function clientToken(workspaceId, assetId, operation, attemptId) {
  const attempt = operation === 'create-asset' ? `:${attemptId}` : '';
  return createHash('sha256').update(`byteplus-assets:v1:${workspaceId}:${assetId}:${operation}${attempt}`).digest('hex');
}

function sharedGroupClientToken(projectName) {
  return createHash('sha256').update(`byteplus-assets:v1:${projectName}:create-group`).digest('hex');
}

function unavailableSourceError() {
  return new BytePlusAssetTrustError('Asset storage is not available to BytePlus.', {
    code: 'BYTEPLUS_ASSET_SOURCE_UNAVAILABLE',
    status: 503,
  });
}

async function createProviderSourceUrl(storage, storageKey) {
  let sourceUrl;
  try {
    const download = await storage.createDownloadUrl({
      key: storageKey,
      expiresInSeconds: SOURCE_URL_TTL_SECONDS,
    });
    sourceUrl = download?.url || download;
  } catch {
    throw unavailableSourceError();
  }
  try {
    if (new URL(sourceUrl).protocol !== 'https:') throw unavailableSourceError();
  } catch (error) {
    if (error instanceof BytePlusAssetTrustError) throw error;
    throw unavailableSourceError();
  }
  return sourceUrl;
}

export class BytePlusAssetTrustError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'BytePlusAssetTrustError';
    this.code = code;
    this.status = status;
  }
}

export function projectBytePlusTrustState(link) {
  const status = link?.status || link?.byteplus_trust_status;
  if (!status) return { status: 'not_trusted' };
  if (status === 'active' && (link.provider_asset_id === null || link.byteplus_has_provider_asset === false)) {
    return { status: 'failed', error: INVALID_STATE_FAILURE };
  }
  if (status === 'failed') {
    if (link?.error?.code === 'BYTEPLUS_ASSET_NOT_FOUND') return { status: 'not_trusted' };
    return { status: 'failed', error: link?.error?.code === PROJECT_MISMATCH_FAILURE.code ? PROJECT_MISMATCH_FAILURE : PROCESSING_FAILURE };
  }
  return { status };
}

function invalidProviderResult() {
  return new BytePlusAssetTrustError('Unable to update trusted asset.', {
    code: 'BYTEPLUS_ASSET_TRUST_FAILED',
    status: 502,
  });
}

function requireProviderId(result) {
  if (typeof result?.Id !== 'string' || !result.Id.trim()) throw invalidProviderResult();
  return result.Id;
}

const defaultRepository = {
  compareAndSetBytePlusAssetLinkStatus,
  createProcessingBytePlusAssetLink,
  findBytePlusAssetLink,
  markBytePlusAssetLinkStale,
  resetBytePlusAssetLink,
  updateBytePlusAssetLink,
};

export function createBytePlusAssetTrustService({
  pool = getPool(),
  storage = createStorage(),
  assetsClientFactory = createBytePlusAssetsClient,
  repository = defaultRepository,
  env = process.env,
  attemptIdFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  async function loadAsset(client, workspaceId, assetId, { lock = false } = {}) {
    const result = await client.query(
      `SELECT id, workspace_id, storage_key, filename, content_type
       FROM assets WHERE workspace_id = $1 AND id = $2 LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [workspaceId, assetId],
    );
    return result.rows[0] || null;
  }

  async function startTrust(workspaceId, assetId) {
    const provider = assetsClientFactory({ env });
    const projectName = env.BYTEPLUS_PROJECT_NAME?.trim() || 'default';
    const configuredGroupId = env.BYTEPLUS_ASSET_GROUP_ID?.trim() || null;
    const client = await pool.connect();
    let asset;
    let link;
    let sourceUrl;
    let ownsClaim = false;
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      asset = await loadAsset(client, workspaceId, assetId, { lock: true });
      if (!asset) {
        await client.query('COMMIT');
        return null;
      }
      if (!asset.content_type?.startsWith('image/')) {
        throw new BytePlusAssetTrustError('Only image assets can be trusted for Seedance.', {
          code: 'BYTEPLUS_ASSET_TYPE_UNSUPPORTED', status: 400,
        });
      }

      link = await repository.findBytePlusAssetLink(client, workspaceId, assetId);
      const projectMatches = link?.project_name === projectName;
      if (projectMatches && link?.provider_asset_id && link.status === 'processing') {
        await client.query('COMMIT');
        return projectBytePlusTrustState(link);
      }
      if (projectMatches && link?.provider_asset_id && link.status === 'active') {
        const staleSnapshot = { ...link };
        await client.query('COMMIT');
        inTransaction = false;
        try {
          const providerState = mapBytePlusAssetStatus(await provider.getAsset({ assetId: link.provider_asset_id }));
          if (providerState.status === 'active') return { status: 'active' };
          if (providerState.status === 'processing') {
            const processing = await repository.compareAndSetBytePlusAssetLinkStatus(client, {
              workspaceId, localAssetId: assetId, expectedStatus: 'active',
              expectedProviderAssetId: staleSnapshot.provider_asset_id,
              expectedAttemptId: staleSnapshot.attempt_id, status: 'processing', error: null,
            });
            return projectBytePlusTrustState(processing || await repository.findBytePlusAssetLink(client, workspaceId, assetId));
          }
        } catch (error) {
          if (!isBytePlusAssetNotFound(error)) throw error;
        }
        const invalidated = await repository.markBytePlusAssetLinkStale(client, {
          workspaceId, localAssetId: assetId,
          providerAssetId: staleSnapshot.provider_asset_id,
          attemptId: staleSnapshot.attempt_id,
          errorCode: 'BYTEPLUS_ASSET_NOT_FOUND',
        });
        if (!invalidated) {
          return projectBytePlusTrustState(await repository.findBytePlusAssetLink(client, workspaceId, assetId));
        }
        await client.query('BEGIN');
        inTransaction = true;
        asset = await loadAsset(client, workspaceId, assetId, { lock: true });
        link = await repository.findBytePlusAssetLink(client, workspaceId, assetId);
        if (!asset || link?.attempt_id !== staleSnapshot.attempt_id || link?.provider_asset_id !== staleSnapshot.provider_asset_id || link?.status !== 'failed') {
          await client.query('COMMIT');
          inTransaction = false;
          return projectBytePlusTrustState(link);
        }
      }
      const claimAge = now().getTime() - new Date(link?.updated_at || 0).getTime();
      if (projectMatches && link?.status === 'processing' && !link.provider_asset_id && claimAge < CLAIM_STALE_MS) {
        await client.query('COMMIT');
        return projectBytePlusTrustState(link);
      }

      sourceUrl = await createProviderSourceUrl(storage, asset.storage_key);
      if (!link) {
        link = await repository.createProcessingBytePlusAssetLink(client, {
          workspaceId, localAssetId: assetId, projectName, attemptId: attemptIdFactory(),
        });
      } else if (link.status === 'failed' || link.status === 'active' || !projectMatches) {
        link = await repository.resetBytePlusAssetLink(client, {
          workspaceId, localAssetId: assetId, projectName, attemptId: attemptIdFactory(), clearGroup: !projectMatches,
        });
      }
      ownsClaim = true;
      await client.query('COMMIT');
      inTransaction = false;

      const attemptId = link.attempt_id;
      let groupId = link.group_id || configuredGroupId;
      if (!groupId) {
        groupId = requireProviderId(await provider.createAssetGroup({
          name: SHARED_GROUP_NAME,
          description: SHARED_GROUP_DESCRIPTION,
          clientToken: sharedGroupClientToken(projectName),
        }));
        link = await repository.updateBytePlusAssetLink(client, {
          workspaceId, localAssetId: assetId, groupId, status: 'processing', error: null,
          expectedAttemptId: attemptId,
        });
        if (!link) return projectBytePlusTrustState(await repository.findBytePlusAssetLink(client, workspaceId, assetId));
      }

      if (!link.provider_asset_id) {
        const providerAssetId = requireProviderId(await provider.createAsset({
          groupId, url: sourceUrl, name: asset.filename,
          clientToken: clientToken(workspaceId, assetId, 'create-asset', attemptId),
        }));
        link = await repository.updateBytePlusAssetLink(client, {
          workspaceId, localAssetId: assetId, groupId, providerAssetId, status: 'processing', error: null,
          expectedAttemptId: attemptId,
        });
        if (!link) return projectBytePlusTrustState(await repository.findBytePlusAssetLink(client, workspaceId, assetId));
      }
      return projectBytePlusTrustState(link);
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK');
      if (!inTransaction && ownsClaim && error instanceof BytePlusAssetsError && !error.retryable) {
        await repository.updateBytePlusAssetLink(client, {
          workspaceId, localAssetId: assetId, status: 'failed',
          error: { code: 'BYTEPLUS_ASSET_TRUST_FAILED', message: 'BytePlus could not trust this asset.' },
          expectedAttemptId: link?.attempt_id,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getTrust(workspaceId, assetId) {
    const provider = assetsClientFactory({ env });
    const client = await pool.connect();
    try {
      const asset = await loadAsset(client, workspaceId, assetId);
      if (!asset) return null;
      const link = await repository.findBytePlusAssetLink(client, workspaceId, assetId);
      if (!link) return { status: 'not_trusted' };
      const projectName = env.BYTEPLUS_PROJECT_NAME?.trim() || 'default';
      if (link.project_name !== projectName) {
        const failed = await repository.compareAndSetBytePlusAssetLinkStatus(client, {
          workspaceId, localAssetId: assetId,
          expectedStatus: link.status, expectedProviderAssetId: link.provider_asset_id,
          expectedAttemptId: link.attempt_id,
          status: 'failed', error: PROJECT_MISMATCH_FAILURE,
        });
        return projectBytePlusTrustState(failed || { ...link, status: 'failed', error: PROJECT_MISMATCH_FAILURE });
      }
      if (link.status === 'active' && !link.provider_asset_id) {
        const failed = await repository.compareAndSetBytePlusAssetLinkStatus(client, {
          workspaceId,
          localAssetId: assetId,
          expectedStatus: 'active',
          expectedProviderAssetId: null,
          expectedAttemptId: link.attempt_id,
          status: 'failed',
          error: INVALID_STATE_FAILURE,
        });
        return projectBytePlusTrustState(failed || await repository.findBytePlusAssetLink(client, workspaceId, assetId));
      }
      if (!['active', 'processing'].includes(link.status) || !link.provider_asset_id) return projectBytePlusTrustState(link);

      let state;
      try {
        state = mapBytePlusAssetStatus(await provider.getAsset({ assetId: link.provider_asset_id }));
      } catch (error) {
        if (!isBytePlusAssetNotFound(error)) throw error;
        const invalidated = await repository.markBytePlusAssetLinkStale(client, {
          workspaceId, localAssetId: assetId, providerAssetId: link.provider_asset_id,
          attemptId: link.attempt_id, errorCode: 'BYTEPLUS_ASSET_NOT_FOUND',
        });
        return invalidated
          ? { status: 'not_trusted' }
          : projectBytePlusTrustState(await repository.findBytePlusAssetLink(client, workspaceId, assetId));
      }
      const updated = await repository.compareAndSetBytePlusAssetLinkStatus(client, {
        workspaceId,
        localAssetId: assetId,
        expectedStatus: link.status,
        expectedProviderAssetId: link.provider_asset_id,
        expectedAttemptId: link.attempt_id,
        status: state.status,
        error: state.error || null,
      });
      return projectBytePlusTrustState(updated || await repository.findBytePlusAssetLink(client, workspaceId, assetId));
    } finally {
      client.release();
    }
  }

  return { startTrust, getTrust };
}

export async function startBytePlusAssetTrust(workspaceId, assetId) {
  return createBytePlusAssetTrustService().startTrust(workspaceId, assetId);
}

export async function getBytePlusAssetTrust(workspaceId, assetId) {
  return createBytePlusAssetTrustService().getTrust(workspaceId, assetId);
}
