import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQueuedGenerationPatch,
  createTerminalGenerationPatch,
  needsDurableGenerationRecovery,
} from './durable-generation'

test('creates a queued patch retaining the durable job id', () => {
  assert.deepEqual(createQueuedGenerationPatch({ id: 'g1', kind: 'image', status: 'queued' }), {
    generationId: 'g1', generationStatus: 'queued', generationError: null,
  })
})

test('normalizes active durable states', () => {
  assert.deepEqual(createQueuedGenerationPatch({ id: 'g1', kind: 'image', status: 'running' }), {
    generationId: 'g1', generationStatus: 'processing', generationError: null,
  })
  assert.deepEqual(createQueuedGenerationPatch({ id: 'g1', kind: 'image', status: 'processing' }), {
    generationId: 'g1', generationStatus: 'processing', generationError: null,
  })
})

test('creates a completed patch from the first durable output URL', () => {
  assert.deepEqual(createTerminalGenerationPatch({
    id: 'g1', kind: 'image', status: 'succeeded', outputs: [{ assetId: 'a1', download: { url: '/api/assets/a/download' } }],
  }), {
    generationStatus: 'completed', generationError: null, outputUrl: '/api/assets/a/download', status: 'completed', error: null,
  })
})

test('creates failed patches for failed or outputless durable generations', () => {
  assert.deepEqual(createTerminalGenerationPatch({ id: 'g1', kind: 'image', status: 'succeeded' }), {
    generationStatus: 'failed', generationError: 'Generation completed without media output.', status: 'failed', error: 'Generation completed without media output.',
  })
  assert.deepEqual(createTerminalGenerationPatch({ id: 'g1', kind: 'image', status: 'failed', error: { message: 'Bad prompt' } }), {
    generationStatus: 'failed', generationError: 'Bad prompt', status: 'failed', error: 'Bad prompt',
  })
  assert.deepEqual(createTerminalGenerationPatch({ id: 'g1', kind: 'image', status: 'failed' }), {
    generationStatus: 'failed', generationError: 'Generation failed. Please retry.', status: 'failed', error: 'Generation failed. Please retry.',
  })
})

test('does not create a terminal patch for an active durable generation', () => {
  assert.equal(createTerminalGenerationPatch({ id: 'g1', kind: 'image', status: 'queued' }), null)
})

test('marks only non-terminal durable nodes for recovery', () => {
  assert.equal(needsDurableGenerationRecovery({ generationId: 'g1', generationStatus: 'processing' }), true)
  assert.equal(needsDurableGenerationRecovery({ generationId: 'g1', generationStatus: 'completed' }), false)
})
