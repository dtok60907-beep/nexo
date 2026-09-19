import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createStableAssetId } from '@/app/api/assets/route'

const imageNode = readFileSync(
  new URL('../components/canvas/nodes/image-node.tsx', import.meta.url),
  'utf8',
)
const folderModal = readFileSync(
  new URL('../components/canvas/add-to-folder-modal.tsx', import.meta.url),
  'utf8',
)
const assetsRoute = readFileSync(
  new URL('../app/api/assets/route.ts', import.meta.url),
  'utf8',
)

test('image generation node exposes generated output to the folder modal', () => {
  assert.match(imageNode, /import \{ AddToFolderModal \}/)
  assert.match(imageNode, /onAddToFolder=\{outputUrl \? handleAddToFolder : undefined\}/)
  assert.match(imageNode, /<AddToFolderModal[\s\S]*?assetUrl=\{outputUrl\}/)
})

test('legacy generated images use the same-origin import helper instead of direct cross-origin fetch', () => {
  assert.match(folderModal, /importImageForTrust/)
  assert.doesNotMatch(folderModal, /const source = await fetch\(assetUrl\)/)
})

test('canonical workspace images skip cross-origin byte downloads when added to a folder', () => {
  assert.match(folderModal, /workspaceAssetIdFromUrl/)
  assert.match(folderModal, /const canonicalAssetId = workspaceAssetIdFromUrl\(assetUrl\)/)
  assert.match(folderModal, /if \(canonicalAssetId\) return \{ id: legacyId, workspaceAssetId: canonicalAssetId, url: assetUrl \}/)
})

test('canonical import replaces the matching legacy selection', () => {
  assert.match(folderModal, /readyAssets = \[\.\.\.readyAssets\.filter\(asset => asset\.id !== generatedAsset\.id\), generatedAsset\]/)
  assert.doesNotMatch(folderModal, /if \(!readyAssets\.some\(asset => asset\.id === generatedAsset\.id\)\)/)
})

test('folder modal registers an unindexed generated output and uses the resolved asset id', () => {
  assert.match(folderModal, /registerAssetByUrl/)
  assert.doesNotMatch(folderModal, /if \(!assetId\) return/)
  assert.match(folderModal, /const resolvedAsset = assetUrl[\s\S]*?await registerAssetByUrl\(\)/)
  assert.match(folderModal, /addAssetIds: \[resolvedAssetId\]/)
})

test('new folder creation waits for generated asset registration', () => {
  assert.match(
    folderModal,
    /const handleSave[\s\S]*?await registerAssetByUrl\(\)[\s\S]*?assetIds[\s\S]*?fetch\(withBasePath\('\/api\/folders'\)/,
  )
})

test('new folder success callback prefers server-returned normalized name', () => {
  // Ensure we parse the response and prefer parsed.name with a trimmed fallback
  assert.match(folderModal, /parsed\?\.name/)
  assert.match(folderModal, /const\s+effectiveName\s*=\s*serverName\s*\|\|\s*newName\.trim\(\)/)
  assert.match(folderModal, /onAdded\(\{ id, name: effectiveName, type: folderType \}\)/)
})

test('generated asset registration is idempotent across concurrent service instances', () => {
  const first = createStableAssetId('project-a', '/api/assets/output/download')
  assert.equal(first, createStableAssetId('project-a', '/api/assets/output/download'))
  assert.notEqual(first, createStableAssetId('project-b', '/api/assets/output/download'))
  assert.notEqual(first, createStableAssetId('project-a', '/api/assets/other/download'))
  assert.match(assetsRoute, /ON CONFLICT \(id\) DO UPDATE/)
})
