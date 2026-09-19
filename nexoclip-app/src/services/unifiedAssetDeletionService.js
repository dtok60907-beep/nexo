import { isBytePlusAssetNotFound } from '../providers/byteplusAssetsClient.js';

export class UnifiedAssetDeletionError extends Error {
  constructor(message, { code, status = 409, retryable = false } = {}) {
    super(message);
    this.name = 'UnifiedAssetDeletionError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const failure = (message, options) => new UnifiedAssetDeletionError(message, options);

export async function deleteTrustedWorkspaceAsset({
  workspaceId,
  localAssetId,
  pool,
  storage,
  bytePlusClient,
  cleanupCanvasReferences,
  configuredProjectName,
}) {
  if (!workspaceId || !localAssetId) throw failure('Asset identity is required.', { code: 'ASSET_DELETE_INVALID', status: 400 });
  const snapshotClient = await pool.connect();
  let asset;
  try {
    await snapshotClient.query('BEGIN');
    const result = await snapshotClient.query(
      `SELECT a.id, a.workspace_id, a.storage_key,
              bal.provider_asset_id, bal.project_name, bal.attempt_id
       FROM assets a
       LEFT JOIN byteplus_asset_links bal
         ON bal.workspace_id = a.workspace_id AND bal.local_asset_id = a.id
       WHERE a.workspace_id = $1 AND a.id = $2
       FOR UPDATE OF a`,
      [workspaceId, localAssetId],
    );
    asset = result.rows[0] || null;
    await snapshotClient.query('COMMIT');
  } catch (error) {
    await snapshotClient.query('ROLLBACK');
    throw error;
  } finally {
    snapshotClient.release();
  }
  if (!asset) return null;

  if (asset.provider_asset_id && asset.project_name !== configuredProjectName) {
    throw failure('Trusted asset belongs to another BytePlus project.', {
      code: 'BYTEPLUS_PROJECT_MISMATCH', status: 409,
    });
  }

  let providerAlreadyMissing = false;
  if (asset.provider_asset_id) {
    try {
      await bytePlusClient.deleteAsset({ assetId: asset.provider_asset_id, projectName: asset.project_name });
    } catch (error) {
      if (isBytePlusAssetNotFound(error)) providerAlreadyMissing = true;
      else throw failure('BytePlus asset deletion can be retried.', {
        code: 'BYTEPLUS_ASSET_DELETE_RETRYABLE', status: 503, retryable: true,
      });
    }
  }

  const canvas = await cleanupCanvasReferences({
    workspaceId, localAssetId, canonicalUrl: `/api/assets/${encodeURIComponent(localAssetId)}/download`,
  }).catch(() => ({ complete: false }));
  if (!canvas?.complete) {
    throw failure('Canvas reference cleanup is incomplete.', {
      code: 'CANVAS_REFERENCE_CLEANUP_INCOMPLETE', status: 503, retryable: true,
    });
  }

  try {
    await storage.delete(asset.storage_key);
  } catch {
    throw failure('Asset storage deletion failed.', {
      code: 'ASSET_STORAGE_DELETE_FAILED', status: 503, retryable: true,
    });
  }

  const finalClient = await pool.connect();
  try {
    await finalClient.query('BEGIN');
    if (asset.provider_asset_id) {
      const deletedLink = await finalClient.query(
        `DELETE FROM byteplus_asset_links
         WHERE workspace_id = $1 AND local_asset_id = $2
           AND provider_asset_id = $3 AND attempt_id = $4`,
        [workspaceId, localAssetId, asset.provider_asset_id, asset.attempt_id],
      );
      if (deletedLink.rowCount !== 1) {
        throw failure('Asset Trust changed during deletion.', { code: 'ASSET_TRUST_CHANGED', status: 409, retryable: true });
      }
    }
    await finalClient.query('DELETE FROM generation_outputs WHERE workspace_id = $1 AND asset_id = $2', [workspaceId, localAssetId]);
    const deleted = asset.provider_asset_id
      ? await finalClient.query('DELETE FROM assets WHERE workspace_id = $1 AND id = $2', [workspaceId, localAssetId])
      : await finalClient.query(
        `DELETE FROM assets a
         WHERE a.workspace_id = $1 AND a.id = $2
           AND NOT EXISTS (
             SELECT 1 FROM byteplus_asset_links bal
             WHERE bal.workspace_id = a.workspace_id AND bal.local_asset_id = a.id
           )`,
        [workspaceId, localAssetId],
      );
    if (deleted.rowCount !== 1) throw failure('Asset changed during deletion.', { code: 'ASSET_DELETE_CHANGED', status: 409, retryable: true });
    await finalClient.query('COMMIT');
  } catch (error) {
    await finalClient.query('ROLLBACK');
    throw error;
  } finally {
    finalClient.release();
  }
  return { deleted: true, providerAlreadyMissing };
}
