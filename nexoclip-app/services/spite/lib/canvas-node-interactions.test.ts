import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge, Node } from '@xyflow/react'

import {
  clampNodeSize,
  parseAspectRatio,
  createGenerationStatusQuery,
  getGenerationPromptState,
  resolveFollowTarget,
  resolveIncomingPrompt,
} from './canvas-node-interactions'

const nodes: Node[] = [
  { id: 'prompt-a', type: 'prompt', position: { x: 0, y: 0 }, data: { text: ' alpha ' } },
  { id: 'prompt-b', type: 'prompt', position: { x: 0, y: 0 }, data: { text: ' beta ' } },
  { id: 'prompt-empty', type: 'prompt', position: { x: 0, y: 0 }, data: { text: '   ' } },
  { id: 'image-1', type: 'image', position: { x: 50, y: 75 }, data: {} },
  { id: 'image-2', type: 'image', position: { x: 12, y: 34 }, data: { sceneId: 'scene-2' } },
  { id: 'image-3', type: 'image', position: { x: 56, y: 78 }, data: { sceneId: 'scene-3' } },
]

const edgeA: Edge = {
  id: 'edge-a',
  source: 'prompt-a',
  target: 'image-1',
  targetHandle: 'prompt-in',
}
const edgeB: Edge = {
  id: 'edge-b',
  source: 'prompt-b',
  target: 'image-1',
  targetHandle: 'prompt-in',
}

test('resolveIncomingPrompt uses the first prompt edge by ID', () => {
  assert.deepEqual(resolveIncomingPrompt('image-1', nodes, [edgeB, edgeA]), {
    connected: true,
    prompt: 'alpha',
  })
})

test('resolveIncomingPrompt reports no connection without a prompt edge', () => {
  assert.deepEqual(resolveIncomingPrompt('image-1', nodes, []), {
    connected: false,
    prompt: '',
  })
})

test('resolveIncomingPrompt reports a connected empty Text node', () => {
  assert.deepEqual(resolveIncomingPrompt('image-1', nodes, [{ ...edgeA, source: 'prompt-empty' }]), {
    connected: true,
    prompt: '',
  })
})

test('resolveIncomingPrompt ignores non-prompt source nodes', () => {
  assert.deepEqual(resolveIncomingPrompt('image-1', nodes, [{ ...edgeA, source: 'image-2' }]), {
    connected: false,
    prompt: '',
  })
})

test('resolveIncomingPrompt ignores legacy edges without the prompt-in target', () => {
  assert.deepEqual(resolveIncomingPrompt('image-1', nodes, [{ ...edgeA, targetHandle: null }]), {
    connected: false,
    prompt: '',
  })
})

test('generation gating requires a connected Text node with text', () => {
  assert.deepEqual(getGenerationPromptState('image-1', nodes, []), {
    connected: false, prompt: '', disabled: true, message: 'Connect a Text node first',
  })
  assert.deepEqual(getGenerationPromptState('image-1', nodes, [{ ...edgeA, source: 'prompt-empty' }]), {
    connected: true, prompt: '', disabled: true, message: 'Enter text in the connected Text node',
  })
  assert.deepEqual(getGenerationPromptState('image-1', nodes, [edgeA]), {
    connected: true, prompt: 'alpha', disabled: false, message: undefined,
  })
})

test('status payload uses the durable generation identity only', () => {
  const query = createGenerationStatusQuery({
    nodeId: 'image-1', generationId: 'generation-1', projectId: 'project-1',
  })

  assert.deepEqual([...query.entries()], [
    ['projectId', 'project-1'],
    ['nodeId', 'image-1'],
    ['generationId', 'generation-1'],
  ])
})

test('parseAspectRatio parses a landscape ratio', () => {
  assert.equal(parseAspectRatio('16:9', '1:1'), 16 / 9)
})

test('parseAspectRatio parses a portrait ratio', () => {
  assert.equal(parseAspectRatio('9:16', '1:1'), 9 / 16)
})

test('parseAspectRatio falls back for malformed values', () => {
  assert.equal(parseAspectRatio('bad', '16:9'), 16 / 9)
})

test('clampNodeSize raises dimensions below their minimum bounds', () => {
  assert.deepEqual(
    clampNodeSize({ width: 80, height: 90 }, { minWidth: 100, maxWidth: 800, minHeight: 120, maxHeight: 600 }),
    { width: 100, height: 120 },
  )
})

test('clampNodeSize lowers dimensions above their maximum bounds', () => {
  assert.deepEqual(
    clampNodeSize({ width: 900, height: 700 }, { minWidth: 100, maxWidth: 800, minHeight: 120, maxHeight: 600 }),
    { width: 800, height: 600 },
  )
})

test('resolveFollowTarget prefers cursor then selected node', () => {
  assert.deepEqual(resolveFollowTarget({ cursor: { x: 12, y: 34 }, selection: { nodeIds: ['image-2'] } }, nodes), {
    sceneId: 'scene-2',
    point: { x: 12, y: 34 },
  })
})

test('resolveFollowTarget uses the peer scene for a cursor without a selection', () => {
  assert.deepEqual(resolveFollowTarget({ sceneId: 'scene-3', cursor: { x: 12, y: 34 } }, nodes), {
    sceneId: 'scene-3',
    point: { x: 12, y: 34 },
  })
})

test('resolveFollowTarget ignores stale cross-scene selections when peer scene exists', () => {
  assert.deepEqual(resolveFollowTarget({ sceneId: 'scene-3', selection: { nodeIds: ['image-2', 'image-3'] } }, nodes), {
    sceneId: 'scene-3',
    point: { x: 56, y: 78 },
  })
})

test('resolveFollowTarget falls back to the first selected node', () => {
  assert.deepEqual(resolveFollowTarget({ selection: { nodeIds: ['image-2'] } }, nodes), {
    sceneId: 'scene-2',
    point: { x: 12, y: 34 },
  })
})

test('resolveFollowTarget returns an empty target when the peer has no cursor or selected node', () => {
  assert.deepEqual(resolveFollowTarget({ selection: { nodeIds: ['missing'] } }, nodes), {})
})
