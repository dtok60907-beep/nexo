import test from 'node:test';
import assert from 'node:assert/strict';

const { createVideoWorker, videoWorkerConfig } = await import('../../src/queue/videoWorker.mjs');

test('video worker defaults to three concurrent jobs', () => {
  assert.deepEqual(videoWorkerConfig({ REDIS_URL: 'redis://localhost:6379' }), {
    redisUrl: 'redis://localhost:6379', concurrency: 3,
  });
  assert.deepEqual(videoWorkerConfig({ REDIS_URL: 'redis://localhost:6379', VIDEO_WORKER_CONCURRENCY: '3' }), {
    redisUrl: 'redis://localhost:6379', concurrency: 3,
  });
  assert.throws(() => videoWorkerConfig({ REDIS_URL: 'redis://localhost:6379', VIDEO_WORKER_CONCURRENCY: '0' }), /integer between 1 and 8/);
});

test('video worker injects trusted mapping lookup and environment into only its handler', async () => {
  let handlerDependencies;
  const env = { REDIS_URL: 'redis://test', BYTEPLUS_SEEDANCE_2_ENDPOINT: 'ep-private' };
  const findBytePlusAssetLink = async () => null;
  class Redis {
    async quit() {}
  }
  const worker = { async pause() {}, async close() {} };
  const queue = {
    createWorker() { return worker; },
    async close() {},
  };

  const service = await createVideoWorker({
    env,
    Redis,
    loadPool: () => ({ id: 'pool' }),
    closeDatabasePool: async () => {},
    createQueue: () => queue,
    createHandler(dependencies) { handlerDependencies = dependencies; return async () => ({}); },
    findBytePlusAssetLink,
    recover: async () => {},
    recoverUnreserved: async () => {},
    createStorage: () => ({ id: 'storage' }),
    createReferenceStorage: () => ({ id: 'references' }),
    schedule: () => ({ unref() {} }),
    clearSchedule: () => {},
  });

  assert.equal(handlerDependencies.env, env);
  assert.equal(handlerDependencies.findBytePlusAssetLink, findBytePlusAssetLink);
  await service.close();
});
