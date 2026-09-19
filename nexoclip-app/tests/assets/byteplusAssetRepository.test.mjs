import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const migrationsUrl = new URL('../../src/db/migrations/', import.meta.url);
const assetKeyMigrationUrl = new URL('013_generation_outputs_usage.sql', migrationsUrl);
const migrationUrl = new URL('024_byteplus_asset_links.sql', migrationsUrl);
const repositoryUrl = new URL('../../src/repositories/byteplusAssetRepository.js', import.meta.url);

async function repository() {
  return import(repositoryUrl);
}

test('migration runs after its composite asset key dependency and defines matching constraints', async () => {
  const filenames = (await readdir(migrationsUrl))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const dependencyIndex = filenames.indexOf('013_generation_outputs_usage.sql');
  const migrationIndex = filenames.indexOf('024_byteplus_asset_links.sql');
  const [assetKeySql, sql] = await Promise.all([
    readFile(assetKeyMigrationUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ]);

  assert.notEqual(dependencyIndex, -1);
  assert.ok(migrationIndex > dependencyIndex);
  assert.match(assetKeySql, /CREATE UNIQUE INDEX IF NOT EXISTS assets_workspace_id_id_idx\s+ON assets \(workspace_id, id\)/);
  assert.match(sql, /-- Requires 013_generation_outputs_usage\.sql: assets\(workspace_id, id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, local_asset_id\)\s+REFERENCES assets\(workspace_id, id\) ON DELETE CASCADE/);
  assert.match(sql, /attempt_id UUID NOT NULL/);
  assert.match(sql, /CHECK \(status IN \('processing', 'active', 'failed'\)\)/);
  assert.match(sql, /UNIQUE \(workspace_id, local_asset_id\)/);
});

test('find scopes BytePlus asset links to workspace and local asset', async () => {
  const { findBytePlusAssetLink } = await repository();
  const calls = [];
  const row = { id: 'link-1', workspace_id: 'workspace-1', local_asset_id: 'asset-1' };
  const client = { async query(text, values) { calls.push({ text, values }); return { rows: [row] }; } };

  assert.equal(await findBytePlusAssetLink(client, 'workspace-1', 'asset-1'), row);
  assert.match(calls[0].text, /WHERE workspace_id = \$1 AND local_asset_id = \$2/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'asset-1']);
});

test('processing insert is idempotent without overwriting an existing link', async () => {
  const { createProcessingBytePlusAssetLink } = await repository();
  const calls = [];
  const existing = { id: 'link-1', status: 'active', provider_asset_id: 'provider-1' };
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return calls.length === 1 ? { rows: [] } : { rows: [existing] };
    },
  };

  const result = await createProcessingBytePlusAssetLink(client, {
    workspaceId: 'workspace-1', localAssetId: 'asset-1', projectName: 'project-1', attemptId: 'attempt-1',
  });

  assert.equal(result, existing);
  assert.match(calls[0].text, /ON CONFLICT \(workspace_id, local_asset_id\) DO NOTHING/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'asset-1', 'project-1', 'attempt-1']);
  assert.deepEqual(calls[1].values, ['workspace-1', 'asset-1']);
});

test('update changes only the workspace-owned local asset link', async () => {
  const { updateBytePlusAssetLink } = await repository();
  const calls = [];
  const client = { async query(text, values) { calls.push({ text, values }); return { rows: [] }; } };

  const result = await updateBytePlusAssetLink(client, {
    workspaceId: 'workspace-1', localAssetId: 'asset-1', groupId: 'group-1',
    providerAssetId: 'provider-1', status: 'active', error: null,
  });

  assert.equal(result, null);
  assert.match(calls[0].text, /group_id = COALESCE\(\$3, group_id\)/);
  assert.match(calls[0].text, /provider_asset_id = COALESCE\(\$4, provider_asset_id\)/);
  assert.match(calls[0].text, /WHERE workspace_id = \$1 AND local_asset_id = \$2/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'asset-1', 'group-1', 'provider-1', 'active', null, null]);
});

test('status refresh compare-and-set scopes the expected status and provider asset id', async () => {
  const { compareAndSetBytePlusAssetLinkStatus } = await repository();
  const calls = [];
  const row = { id: 'link-1', status: 'active', provider_asset_id: 'provider-1' };
  const client = { async query(text, values) { calls.push({ text, values }); return { rows: [row] }; } };

  assert.equal(await compareAndSetBytePlusAssetLinkStatus(client, {
    workspaceId: 'workspace-1',
    localAssetId: 'asset-1',
    expectedStatus: 'processing',
    expectedProviderAssetId: 'provider-1',
    status: 'active',
    error: null,
  }), row);
  assert.match(calls[0].text, /status = \$3 AND provider_asset_id IS NOT DISTINCT FROM \$4/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'asset-1', 'processing', 'provider-1', 'active', null, null]);
});

test('delete removes only the snapshotted trusted provider attempt', async () => {
  const { deleteBytePlusAssetLink } = await repository();
  const calls = [];
  const client = { async query(text, values) { calls.push({ text, values }); return { rowCount: 1 }; } };

  assert.equal(await deleteBytePlusAssetLink(client, {
    workspaceId: 'workspace-1', localAssetId: 'asset-1', providerAssetId: 'provider-1', attemptId: 'attempt-1',
  }), true);
  assert.match(calls[0].text, /DELETE FROM byteplus_asset_links/);
  assert.match(calls[0].text, /WHERE workspace_id = \$1 AND local_asset_id = \$2/);
  assert.match(calls[0].text, /AND provider_asset_id = \$3/);
  assert.match(calls[0].text, /AND attempt_id = \$4/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'asset-1', 'provider-1', 'attempt-1']);
});

test('stale marking changes only the matching provider attempt and reports whether it changed', async () => {
  const { markBytePlusAssetLinkStale } = await repository();
  const calls = [];
  const client = { async query(text, values) { calls.push({ text, values }); return { rowCount: 1 }; } };

  assert.equal(await markBytePlusAssetLinkStale(client, {
    workspaceId: 'workspace-1', localAssetId: 'asset-1', providerAssetId: 'provider-1',
    attemptId: 'attempt-1', errorCode: 'BYTEPLUS_ASSET_NOT_FOUND',
  }), true);
  assert.match(calls[0].text, /SET status = 'failed'/);
  assert.match(calls[0].text, /WHERE workspace_id = \$1 AND local_asset_id = \$2/);
  assert.match(calls[0].text, /AND provider_asset_id = \$3/);
  assert.match(calls[0].text, /AND attempt_id = \$4/);
  assert.deepEqual(calls[0].values, [
    'workspace-1', 'asset-1', 'provider-1', 'attempt-1',
    JSON.stringify({ code: 'BYTEPLUS_ASSET_NOT_FOUND' }),
  ]);
});

test('reset retains group quota, clears the failed provider asset, and rotates attempt', async () => {
  const { resetBytePlusAssetLink } = await repository();
  const calls = [];
  const row = { id: 'link-1', status: 'processing' };
  const client = { async query(text, values) { calls.push({ text, values }); return { rows: [row] }; } };

  assert.equal(await resetBytePlusAssetLink(client, {
    workspaceId: 'workspace-1', localAssetId: 'asset-1', attemptId: 'attempt-2', projectName: 'project-1',
  }), row);
  assert.match(calls[0].text, /SET provider_asset_id = NULL, attempt_id = \$3, project_name = \$4, status = 'processing'/);
  assert.doesNotMatch(calls[0].text, /group_id = NULL/);
  assert.match(calls[0].text, /WHERE workspace_id = \$1 AND local_asset_id = \$2/);
  assert.deepEqual(calls[0].values, ['workspace-1', 'asset-1', 'attempt-2', 'project-1', false]);
});
