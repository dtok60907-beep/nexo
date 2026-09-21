#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getPool } from '../src/db/pool.js';
import {
  createBytePlusAssetsClient,
  isBytePlusAssetNotFound,
} from '../src/providers/byteplusAssetsClient.js';

export function buildBytePlusAssetLinkReport(rows, configuredProjectName) {
  const ids = predicate => rows.filter(predicate).map(row => row.local_asset_id);
  return {
    total: rows.length,
    activeMissingProvider: ids(row => row.status === 'active' && !row.provider_asset_id),
    projectMismatch: ids(row => row.project_name !== configuredProjectName),
    processing: ids(row => row.status === 'processing'),
    failed: ids(row => row.status === 'failed'),
    providerMissing: [],
    providerStatusMismatch: [],
    providerCheckFailed: [],
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run));
  return results;
}

export async function reportBytePlusAssetLinks({
  pool = getPool(),
  bytePlusClient = createBytePlusAssetsClient(),
  concurrency = 4,
  env = process.env,
} = {}) {
  const result = await pool.query(
    `SELECT local_asset_id, status, provider_asset_id, project_name
     FROM byteplus_asset_links ORDER BY updated_at DESC`,
  );
  const projectName = env.BYTEPLUS_PROJECT_NAME?.trim() || 'default';
  const report = buildBytePlusAssetLinkReport(result.rows, projectName);
  const candidates = result.rows.filter(row => (
    row.status === 'active' && row.provider_asset_id && row.project_name === projectName
  ));
  const checks = await mapWithConcurrency(candidates, concurrency, async row => {
    try {
      const provider = await bytePlusClient.getAsset({
        assetId: row.provider_asset_id,
        projectName: row.project_name,
      });
      return { row, providerStatus: provider.status };
    } catch (error) {
      return { row, missing: isBytePlusAssetNotFound(error) };
    }
  });
  for (const check of checks) {
    if (check.missing) report.providerMissing.push(check.row.local_asset_id);
    else if (!check.providerStatus) report.providerCheckFailed.push(check.row.local_asset_id);
    else if (check.providerStatus !== 'active') report.providerStatusMismatch.push({
      localAssetId: check.row.local_asset_id,
      providerStatus: check.providerStatus,
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportBytePlusAssetLinks()
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => {
      console.error(`BytePlus asset report failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    });
}
