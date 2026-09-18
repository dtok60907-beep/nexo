import test from 'node:test';
import assert from 'node:assert/strict';
import { R2ObjectStorage } from '../../src/storage/r2ObjectStorage.js';

test('uploads generated assets to R2 and returns encoded public URL', async () => {
  const calls = [];
  const storage = new R2ObjectStorage({
    bucket: 'images',
    publicUrl: 'https://cdn.example.test',
    client: { send: async (command) => { calls.push(command.input); } },
  });
  const url = await storage.put('workspace/generated/a b.png', Buffer.from('image'), 'image/png');
  assert.equal(url, 'https://cdn.example.test/workspace/generated/a%20b.png');
  assert.equal(calls[0].Bucket, 'images');
  assert.equal(calls[0].Key, 'workspace/generated/a b.png');
  assert.equal(calls[0].ContentType, 'image/png');
});

test('creates a 300-second provider-fetchable presigned HTTPS GET URL', async () => {
  const storage = new R2ObjectStorage({
    bucket: 'images',
    publicUrl: 'https://cdn.example.test',
    accountId: 'account-id',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    now: () => new Date('2026-09-16T12:34:56.000Z'),
    client: { send: async () => { throw new Error('presigning must not fetch the object'); } },
  });

  const download = await storage.createDownloadUrl({ key: 'workspace/a b!(1).png', expiresInSeconds: 300 });
  const url = new URL(download.url);

  assert.equal(download.method, 'GET');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'account-id.r2.cloudflarestorage.com');
  assert.equal(url.pathname, '/images/workspace/a%20b%21%281%29.png');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20260916T123456Z');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'access-key/20260916/auto/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-Signature'), 'c0e7952b2b8219cb5c902ce86e0dd7a98c36f3df95d18fd39150e55bafaac1c5');
  assert.doesNotMatch(download.url, /secret-key/);
});

test('downloads an object when given its presigned R2 URL', async () => {
  const calls = [];
  const storage = new R2ObjectStorage({
    bucket: 'images',
    publicUrl: 'https://cdn.example.test',
    accountId: 'account-id',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    now: () => new Date('2026-09-16T12:34:56.000Z'),
    client: {
      send: async (command) => {
        calls.push(command.input);
        return { Body: { transformToByteArray: async () => Uint8Array.from([105, 109, 97, 103, 101]) }, ContentType: 'image/png' };
      },
    },
  });
  const download = await storage.createDownloadUrl({ key: 'workspace/a b!(1).png' });

  const object = await storage.get(download.url);

  assert.equal(calls[0].Key, 'workspace/a b!(1).png');
  assert.equal(object.body.toString(), 'image');
  assert.equal(object.contentType, 'image/png');
});

test('downloads R2 streams as provider-readable buffers', async () => {
  const storage = new R2ObjectStorage({
    bucket: 'images',
    publicUrl: 'https://cdn.example.test',
    client: {
      send: async () => ({
        Body: { transformToByteArray: async () => Uint8Array.from([104, 101, 114, 111]) },
        ContentType: 'image/jpeg',
      }),
    },
  });

  const object = await storage.get('uploads/hero.jpeg');
  assert.equal(Buffer.isBuffer(object.body), true);
  assert.equal(object.body.toString(), 'hero');
  assert.equal(object.contentType, 'image/jpeg');
});
