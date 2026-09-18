import test from 'node:test';
import assert from 'node:assert/strict';
import * as assetService from '../../src/services/assetService.js';

const { createStorage, deleteWorkspaceAsset, validateAssetInput } = assetService;
import { R2ObjectStorage } from '../../src/storage/r2ObjectStorage.js';

test('validates asset metadata and restricts content types', () => {
  assert.deepEqual(validateAssetInput({ filename: ' cover.png ', contentType: 'image/png', sizeBytes: 12 }), {
    filename: 'cover.png', contentType: 'image/png', sizeBytes: 12,
  });
});

test('rejects unsupported or oversized assets', () => {
  assert.throws(() => validateAssetInput({ filename: 'page.html', contentType: 'text/html', sizeBytes: 1 }), /content type/);
  assert.throws(() => validateAssetInput({ filename: 'cover.png', contentType: 'image/png', sizeBytes: 50 * 1024 * 1024 + 1 }), /size/);
});

test('imports image bytes into canonical workspace storage and metadata', async () => {
  assert.equal(typeof assetService.importWorkspaceAsset, 'function');
  const writes = [];
  const queries = [];
  const storage = {
    async put(key, body, contentType) { writes.push({ key, body, contentType }); },
  };
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.startsWith('SELECT')) return { rows: [] };
      return { rows: [{ id: values[0], workspace_id: values[1], storage_key: values[2], filename: values[3], content_type: values[4], size_bytes: values[5] }] };
    },
  };

  const result = await assetService.importWorkspaceAsset('workspace-1', {
    filename: 'reference.png', contentType: 'image/png', body: Buffer.from('image'),
  }, storage, pool);

  assert.equal(result.asset.workspace_id, 'workspace-1');
  assert.match(result.url, /^\/api\/assets\/[0-9a-f-]+\/download\?workspace_id=workspace-1$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].contentType, 'image/png');
  assert.equal(queries.length, 2);
});

test('reuses an exact trusted workspace image instead of creating an untrusted duplicate', async () => {
  let writes = 0;
  const trusted = {
    id: 'trusted-asset', workspace_id: 'workspace-1', storage_key: 'workspace-1/trusted',
    filename: 'original.png', content_type: 'image/png', size_bytes: 5,
    provider_asset_id: 'asset-byteplus-1',
  };
  const pool = {
    async query(text) {
      assert.match(text, /JOIN byteplus_asset_links/);
      return { rows: [trusted] };
    },
  };
  const storage = {
    async createDownloadUrl({ key }) { return { url: `download:${key}` }; },
    async get() { return { body: Buffer.from('image'), contentType: 'image/png' }; },
    async put() { writes += 1; },
  };

  const result = await assetService.importWorkspaceAsset('workspace-1', {
    filename: 'copy.png', contentType: 'image/png', body: Buffer.from('image'),
  }, storage, pool);

  assert.equal(result.asset.id, 'trusted-asset');
  assert.equal(result.url, '/api/assets/trusted-asset/download?workspace_id=workspace-1');
  assert.equal(writes, 0);
});

test('does not deduplicate same-size images whose bytes differ', async () => {
  let writes = 0;
  const pool = {
    async query(text, values) {
      if (text.startsWith('SELECT')) {
        return { rows: [{ id: 'different-asset', storage_key: 'workspace-1/different' }] };
      }
      return { rows: [{ id: values[0], workspace_id: values[1], storage_key: values[2] }] };
    },
  };
  const storage = {
    async createDownloadUrl({ key }) { return { url: `download:${key}` }; },
    async get() { return { body: Buffer.from('other'), contentType: 'image/png' }; },
    async put() { writes += 1; },
  };

  const result = await assetService.importWorkspaceAsset('workspace-1', {
    filename: 'copy.png', contentType: 'image/png', body: Buffer.from('image'),
  }, storage, pool);

  assert.notEqual(result.asset.id, 'different-asset');
  assert.equal(writes, 1);
});

test('rejects non-image canonical imports', async () => {
  await assert.rejects(
    assetService.importWorkspaceAsset('workspace-1', {
      filename: 'clip.mp4', contentType: 'video/mp4', body: Buffer.from('video'),
    }, { put: async () => {} }, { query: async () => ({ rows: [] }) }),
    /Only images/,
  );
});

test('normalizes R2 object responses for the storage interface', async () => {
  const storage = new R2ObjectStorage({
    bucket: 'assets', publicUrl: 'https://assets.example.test',
    client: { send: async () => ({ Body: Buffer.from('image'), ContentType: 'image/png' }) },
  });

  assert.deepEqual(await storage.get('workspace/asset.png'), {
    body: Buffer.from('image'), contentType: 'image/png',
  });
})

test('deletes only the workspace-owned asset and its stored object', async () => {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.startsWith('SELECT')) return { rows: [{ id: 'asset-1', workspace_id: 'workspace-1', storage_key: 'workspace-1/asset-1' }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const deleted = [];

  const asset = await deleteWorkspaceAsset('workspace-1', 'asset-1', { async delete(key) { deleted.push(key); } }, pool);

  assert.equal(asset.id, 'asset-1');
  assert.deepEqual(deleted, ['workspace-1/asset-1']);
  assert.deepEqual(queries[1].values, ['workspace-1', 'asset-1']);
  assert.match(queries[2].text, /DELETE FROM generation_outputs/);
  assert.match(queries[3].text, /DELETE FROM assets WHERE workspace_id = \$1 AND id = \$2/);
  assert.equal(queries.at(-1).text, 'COMMIT');
});

test('rolls back asset metadata when object deletion fails', async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text.startsWith('SELECT')) return { rows: [{ id: 'asset-1', storage_key: 'workspace-1/asset-1' }] };
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    deleteWorkspaceAsset('workspace-1', 'asset-1', { async delete() { throw new Error('R2 unavailable'); } }, { async connect() { return client; } }),
    /R2 unavailable/,
  );
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('uses R2 for asset downloads when R2 is configured', async () => {
  const keys = ['R2_BUCKET', 'R2_PUBLIC_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    R2_BUCKET: 'assets',
    R2_PUBLIC_URL: 'https://assets.example.test',
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
  });

  try {
    const storage = createStorage();
    assert.ok(storage instanceof R2ObjectStorage);
    const download = await storage.createDownloadUrl({ key: 'workspace/asset.png', expiresInSeconds: 300 });
    assert.equal(download.method, 'GET');
    assert.equal(new URL(download.url).protocol, 'https:');
    assert.equal(new URL(download.url).searchParams.get('X-Amz-Expires'), '300');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
