const columns = `id, workspace_id, local_asset_id, group_id, provider_asset_id, attempt_id,
  status, error, project_name, created_at, updated_at`;

export async function findBytePlusAssetLink(client, workspaceId, localAssetId) {
  const result = await client.query(
    `SELECT ${columns}
     FROM byteplus_asset_links
     WHERE workspace_id = $1 AND local_asset_id = $2
     LIMIT 1`,
    [workspaceId, localAssetId],
  );
  return result.rows[0] || null;
}

export async function createProcessingBytePlusAssetLink(client, {
  workspaceId, localAssetId, projectName = 'default', attemptId,
}) {
  const result = await client.query(
    `INSERT INTO byteplus_asset_links (workspace_id, local_asset_id, status, project_name, attempt_id)
     VALUES ($1, $2, 'processing', $3, $4)
     ON CONFLICT (workspace_id, local_asset_id) DO NOTHING
     RETURNING ${columns}`,
    [workspaceId, localAssetId, projectName, attemptId],
  );
  return result.rows[0] || findBytePlusAssetLink(client, workspaceId, localAssetId);
}

export async function updateBytePlusAssetLink(client, {
  workspaceId, localAssetId, groupId, providerAssetId, status, error, expectedAttemptId,
}) {
  const result = await client.query(
    `UPDATE byteplus_asset_links
     SET group_id = COALESCE($3, group_id),
         provider_asset_id = COALESCE($4, provider_asset_id),
         status = $5, error = $6::jsonb, updated_at = now()
     WHERE workspace_id = $1 AND local_asset_id = $2
       AND ($7::uuid IS NULL OR attempt_id = $7)
     RETURNING ${columns}`,
    [workspaceId, localAssetId, groupId, providerAssetId, status, error && JSON.stringify(error), expectedAttemptId || null],
  );
  return result.rows[0] || null;
}

export async function compareAndSetBytePlusAssetLinkStatus(client, {
  workspaceId, localAssetId, expectedStatus, expectedProviderAssetId, status, error, expectedAttemptId,
}) {
  const result = await client.query(
    `UPDATE byteplus_asset_links
     SET status = $5, error = $6::jsonb, updated_at = now()
     WHERE workspace_id = $1 AND local_asset_id = $2
       AND status = $3 AND provider_asset_id IS NOT DISTINCT FROM $4
       AND ($7::uuid IS NULL OR attempt_id = $7)
     RETURNING ${columns}`,
    [workspaceId, localAssetId, expectedStatus, expectedProviderAssetId, status, error && JSON.stringify(error), expectedAttemptId || null],
  );
  return result.rows[0] || null;
}

export async function deleteBytePlusAssetLink(client, {
  workspaceId, localAssetId, providerAssetId, attemptId,
}) {
  const result = await client.query(
    `DELETE FROM byteplus_asset_links
     WHERE workspace_id = $1 AND local_asset_id = $2
       AND provider_asset_id = $3 AND attempt_id = $4`,
    [workspaceId, localAssetId, providerAssetId, attemptId],
  );
  return result.rowCount > 0;
}

export async function markBytePlusAssetLinkStale(client, {
  workspaceId, localAssetId, providerAssetId, attemptId, errorCode,
}) {
  const result = await client.query(
    `UPDATE byteplus_asset_links
     SET status = 'failed', error = $5::jsonb, updated_at = now()
     WHERE workspace_id = $1 AND local_asset_id = $2
       AND provider_asset_id = $3 AND attempt_id = $4`,
    [workspaceId, localAssetId, providerAssetId, attemptId, JSON.stringify({ code: errorCode })],
  );
  return result.rowCount > 0;
}

export async function resetBytePlusAssetLink(client, {
  workspaceId, localAssetId, attemptId, projectName, clearGroup = false,
}) {
  const result = await client.query(
    `UPDATE byteplus_asset_links
     SET provider_asset_id = NULL, attempt_id = $3, project_name = $4, status = 'processing',
         group_id = CASE WHEN $5 THEN NULL ELSE group_id END, error = NULL, updated_at = now()
     WHERE workspace_id = $1 AND local_asset_id = $2
     RETURNING ${columns}`,
    [workspaceId, localAssetId, attemptId, projectName, clearGroup],
  );
  return result.rows[0] || null;
}
