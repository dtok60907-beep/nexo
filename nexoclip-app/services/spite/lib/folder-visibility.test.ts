import assert from 'node:assert/strict'
import test from 'node:test'

import { foldersWithUsableAssets } from './folder-visibility'

test('hides empty folders from Assets and mention suggestions', () => {
  assert.deepEqual(foldersWithUsableAssets([
    { id: 'empty', assets: [] },
    { id: 'orphaned', assets: [{ id: 'missing', r2_url: null }] },
    { id: 'natasya', assets: [{ id: 'image-1', r2_url: '/image.png' }] },
  ]), [
    { id: 'natasya', assets: [{ id: 'image-1', r2_url: '/image.png' }] },
  ])
})
