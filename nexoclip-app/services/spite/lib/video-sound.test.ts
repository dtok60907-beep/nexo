import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../components/canvas/nodes/video-node.tsx', import.meta.url), 'utf8')

test('video sound defaults on, preserves explicit false, and exposes no toggle', () => {
  assert.match(source, /useState\(\(data\.enableAudio as boolean \| undefined\) \?\? true\)/)
  assert.match(source, /setEnableAudio\(\(data\.enableAudio as boolean \| undefined\) \?\? true\)/)
  assert.match(source, /enableAudio: true/)
  assert.doesNotMatch(source, /setEnableAudio\(!enableAudio\)/)
  assert.doesNotMatch(source, /SpeakerSlash/)
})
