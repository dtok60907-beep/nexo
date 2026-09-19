import test from 'node:test';
import assert from 'node:assert/strict';
import { BytePlusAssetsError } from '../../src/providers/byteplusAssetsClient.js';
import {
  buildBytePlusAssetLinkReport,
  reportBytePlusAssetLinks,
} from '../../scripts/report-byteplus-asset-links.mjs';

test('report identifies unsafe links without exposing provider IDs or secrets', () => {
  const report = buildBytePlusAssetLinkReport([
    { local_asset_id: 'local-1', status: 'active', provider_asset_id: null, project_name: 'project-x' },
    { local_asset_id: 'local-2', status: 'active', provider_asset_id: 'secret-provider', project_name: 'other' },
    { local_asset_id: 'local-3', status: 'processing', provider_asset_id: 'processing-provider', project_name: 'project-x' },
  ], 'project-x');
  assert.deepEqual(report, {
    total: 3,
    activeMissingProvider: ['local-1'],
    projectMismatch: ['local-2'],
    processing: ['local-3'],
    failed: [],
    providerMissing: [],
    providerStatusMismatch: [],
    providerCheckFailed: [],
  });
  assert.doesNotMatch(JSON.stringify(report), /secret-provider|processing-provider/);
});

test('read-only reconciliation verifies active links with bounded concurrency', async () => {
  const rows = [
    { local_asset_id: 'local-ok', status: 'active', provider_asset_id: 'provider-ok', project_name: 'project-x' },
    { local_asset_id: 'local-gone', status: 'active', provider_asset_id: 'provider-gone', project_name: 'project-x' },
    { local_asset_id: 'local-processing', status: 'active', provider_asset_id: 'provider-processing', project_name: 'project-x' },
    { local_asset_id: 'local-transient', status: 'active', provider_asset_id: 'provider-transient', project_name: 'project-x' },
  ];
  const queries = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pool = { async query(sql) { queries.push(sql); return { rows }; } };
  const bytePlusClient = { async getAsset({ assetId }) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight -= 1;
    if (assetId === 'provider-gone') throw new BytePlusAssetsError('safe', { code: 'AssetNotFound', status: 404 });
    if (assetId === 'provider-transient') throw new BytePlusAssetsError('safe', { code: 'BYTEPLUS_ASSETS_UNAVAILABLE', status: 503, retryable: true });
    return { status: assetId === 'provider-processing' ? 'processing' : 'active' };
  } };

  const report = await reportBytePlusAssetLinks({
    pool, bytePlusClient, concurrency: 2, env: { BYTEPLUS_PROJECT_NAME: 'project-x' },
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT/i);
  assert.ok(maxInFlight <= 2);
  assert.deepEqual(report.providerMissing, ['local-gone']);
  assert.deepEqual(report.providerStatusMismatch, [{ localAssetId: 'local-processing', providerStatus: 'processing' }]);
  assert.deepEqual(report.providerCheckFailed, ['local-transient']);
  assert.doesNotMatch(JSON.stringify(report), /provider-ok|provider-gone|provider-processing|provider-transient/);
});
