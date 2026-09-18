import assert from 'node:assert/strict'
import test from 'node:test'

import { foldersWithUsableAssets } from './folder-visibility'

test('preserves canonical workspace asset identity on visible folder assets', () => {
  assert.deepEqual(foldersWithUsableAssets([
    { id: 'nathan', assets: [{ id: 'legacy-nathan', workspaceAssetId: 'workspace-nathan', r2_url: '/image.png' }] },
  ]), [
    { id: 'nathan', assets: [{ id: 'legacy-nathan', workspaceAssetId: 'workspace-nathan', r2_url: '/image.png' }] },
  ])
})

test('hides empty folders from Assets and mention suggestions', () => {
  assert.deepEqual(foldersWithUsableAssets([
    { id: 'empty', assets: [] },
    { id: 'orphaned', assets: [{ id: 'missing', r2_url: null }] },
    { id: 'natasya', assets: [{ id: 'image-1', r2_url: '/image.png' }] },
  ]), [
    { id: 'natasya', assets: [{ id: 'image-1', r2_url: '/image.png' }] },
  ])
})
