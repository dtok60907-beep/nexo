import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const toolbarSource = readFileSync(
  new URL('../components/canvas/left-toolbar.tsx', import.meta.url),
  'utf8',
)
const mentionFoldersSource = readFileSync(
  new URL('../hooks/use-project-folders.ts', import.meta.url),
  'utf8',
)

test('folder data relies on change events instead of five-second polling', () => {
  assert.doesNotMatch(toolbarSource, /refreshInterval:\s*5000/)
  assert.match(toolbarSource, /window\.addEventListener\('folders-changed'/)
  assert.doesNotMatch(mentionFoldersSource, /refreshInterval/)
  assert.match(mentionFoldersSource, /window\.addEventListener\('folders-changed'/)
})

test('every asset panel image preview is lazy and asynchronously decoded', () => {
  const imageCount = toolbarSource.match(/<img\b/g)?.length ?? 0
  const lazyCount = toolbarSource.match(/loading="lazy"/g)?.length ?? 0
  const asyncCount = toolbarSource.match(/decoding="async"/g)?.length ?? 0

  assert.ok(imageCount > 0)
  assert.equal(lazyCount, imageCount)
  assert.equal(asyncCount, imageCount)
})
