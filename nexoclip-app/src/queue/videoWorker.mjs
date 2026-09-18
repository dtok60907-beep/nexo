import { fileURLToPath } from 'node:url';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getPool, closePool } from '../db/pool.js';
import { createReferenceStorage, createStorage } from '../services/assetService.js';
import { createDefaultSaasVideoHandler } from '../services/saasVideoGeneration.js';
import { findBytePlusAssetLink } from '../repositories/byteplusAssetRepository.js';
import { persistGenerationResult } from '../services/generationOutputService.js';
import { createBullMqGenerationQueue } from './bullmqGenerationQueue.js';
import { recoverQueuedGenerations, generationQueueName } from './generationQueue.js';
import { createGenerationProcessor } from './generationWorker.js';
import { recoverUnreservedGenerations } from '../services/generationCreditSettlementService.js';

export function videoWorkerConfig(env = process.env) {
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');
  const concurrency = Number(env.VIDEO_WORKER_CONCURRENCY || 3);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('VIDEO_WORKER_CONCURRENCY must be an integer between 1 and 8');
  return { redisUrl: env.REDIS_URL, concurrency };
}

export async function createVideoWorker({
  env = process.env, Redis = IORedis, loadPool = getPool, closeDatabasePool = closePool,
  createQueue = createBullMqGenerationQueue, createHandler = createDefaultSaasVideoHandler,
  recover = recoverQueuedGenerations, recoverUnreserved = recoverUnreservedGenerations,
  persistResult = persistGenerationResult, createStorage: loadStorage = createStorage,
  createReferenceStorage: loadReferenceStorage = createReferenceStorage,
  findBytePlusAssetLink: findAssetLink = findBytePlusAssetLink,
  schedule = globalThis.setInterval, clearSchedule = globalThis.clearInterval, onError = console.error,
} = {}) {
  const config = videoWorkerConfig(env);
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const pool = loadPool();
  const queue = createQueue({ Queue, Worker, connection, queueName: generationQueueName('video') });
  const recoverNow = async () => { await recoverUnreserved(pool); return recover({ pool, queue, kind: 'video' }); };
  await recoverNow();
  const interval = schedule(() => recoverNow().catch(onError), 30_000);
  interval.unref?.();
  const storage = loadStorage(env);
  const processor = createGenerationProcessor({
    pool,
    handler: createHandler({ pool, storage, referenceStorage: loadReferenceStorage(env, storage), findBytePlusAssetLink: findAssetLink, env }),
    provider: 'openrouter', persistResult, onError,
  });
  const worker = queue.createWorker(processor, { concurrency: config.concurrency });
  let closed = false;
  return { async close() {
    if (closed) return;
    closed = true;
    clearSchedule(interval);
    await worker.pause();
    await worker.close();
    await queue.close();
    await connection.quit();
    await closeDatabasePool();
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = await createVideoWorker();
  const shutdown = async () => { await service.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
