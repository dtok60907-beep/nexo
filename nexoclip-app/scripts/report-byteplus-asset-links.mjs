#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getPool } from '../src/db/pool.js';

export function buildBytePlusAssetLinkReport(rows, configuredProjectName) {
  const ids = predicate => rows.filter(predicate).map(row => row.local_asset_id);
  return {
    total: rows.length,
    activeMissingProvider: ids(row => row.status === 'active' && !row.provider_asset_id),
    projectMismatch: ids(row => row.project_name !== configuredProjectName),
    processing: ids(row => row.status === 'processing'),
    failed: ids(row => row.status === 'failed'),
  };
}

export async function reportBytePlusAssetLinks({ pool = getPool(), env = process.env } = {}) {
  const result = await pool.query(
    `SELECT local_asset_id, status, provider_asset_id, project_name
     FROM byteplus_asset_links ORDER BY updated_at DESC`,
  );
  return buildBytePlusAssetLinkReport(result.rows, env.BYTEPLUS_PROJECT_NAME?.trim() || 'default');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportBytePlusAssetLinks()
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => {
      console.error(`BytePlus asset report failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    });
}
