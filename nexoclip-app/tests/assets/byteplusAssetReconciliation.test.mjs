import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBytePlusAssetLinkReport } from '../../scripts/report-byteplus-asset-links.mjs';

test('report identifies unsafe links without exposing provider IDs or secrets', () => {
  const report = buildBytePlusAssetLinkReport([
    { local_asset_id: 'local-1', status: 'active', provider_asset_id: null, project_name: 'project-x' },
    { local_asset_id: 'local-2', status: 'active', provider_asset_id: 'secret-provider', project_name: 'other' },
    { local_asset_id: 'local-3', status: 'processing', provider_asset_id: 'processing-provider', project_name: 'project-x' },
  ], 'project-x');
  assert.deepEqual(report, {
    total: 3, activeMissingProvider: ['local-1'], projectMismatch: ['local-2'], processing: ['local-3'], failed: [],
  });
  assert.doesNotMatch(JSON.stringify(report), /secret-provider|processing-provider/);
});
