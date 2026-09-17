import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const toolbarSource = readFileSync(
  new URL('../components/canvas/left-toolbar.tsx', import.meta.url),
  'utf8',
)
const imageNodeSource = readFileSync(new URL('../components/canvas/nodes/image-node.tsx', import.meta.url), 'utf8')
const referenceNodeSource = readFileSync(new URL('../components/canvas/nodes/reference-node.tsx', import.meta.url), 'utf8')
const nodeToolbarSource = readFileSync(new URL('../components/canvas/nodes/node-toolbar.tsx', import.meta.url), 'utf8')

import {
  applyBytePlusTrustState,
  bytePlusTrustUrl,
  bytePlusTrustPollDelay,
  requestBytePlusTrust,
  importImageForTrust,
  safeBytePlusTrustError,
  shouldPollBytePlusTrust,
  trustForSeedanceView,
  trustImportSourceUrl,
  workspaceAssetIdFromUrl,
  resolveWorkspaceAssetId,
} from '@/lib/byteplus-trust'

test('trust URL targets the unprefixed main app and encodes the asset ID', () => {
  assert.equal(
    bytePlusTrustUrl('asset/with space'),
    '/api/assets/asset%2Fwith%20space/byteplus-trust',
  )
})

test('extracts only canonical workspace asset ids from image URLs', () => {
  assert.equal(workspaceAssetIdFromUrl('/api/assets/2b3a6608-ff3f-45ef-a323-ec9e9e08d399/download?workspace_id=w1'), '2b3a6608-ff3f-45ef-a323-ec9e9e08d399')
  assert.equal(workspaceAssetIdFromUrl('https://app.test/api/assets/2b3a6608-ff3f-45ef-a323-ec9e9e08d399/download?workspace_id=w1'), '2b3a6608-ff3f-45ef-a323-ec9e9e08d399')
  assert.equal(workspaceAssetIdFromUrl('/spite/api/r2-image/uploads/reference.png'), null)
  assert.equal(workspaceAssetIdFromUrl('asset://provider-id'), null)
})

test('recovers trusted identity from persisted node data when display URL is signed R2', () => {
  const assetId = '2b3a6608-ff3f-45ef-a323-ec9e9e08d399'
  const signedR2 = 'https://bucket.r2.cloudflarestorage.com/uploads/reference.png?X-Amz-Signature=secret'

  assert.equal(resolveWorkspaceAssetId(signedR2, assetId), assetId)
  assert.equal(resolveWorkspaceAssetId(signedR2, 'not-a-uuid'), null)
})

test('legacy R2 proxy imports request a private same-origin trust copy', () => {
  assert.equal(
    trustImportSourceUrl('/spite/api/r2-image/uploads/reference.png'),
    '/spite/api/r2-image/uploads/reference.png?trust_import=1',
  )
  assert.equal(
    trustImportSourceUrl('/spite/api/r2-image/uploads/reference.png?version=2'),
    '/spite/api/r2-image/uploads/reference.png?version=2&trust_import=1',
  )
  assert.equal(trustImportSourceUrl('https://other.example/reference.png'), 'https://other.example/reference.png')
})

test('imports browser-readable legacy images before trust', async () => {
  const calls: Array<{ input: string; method?: string }> = []
  const result = await importImageForTrust({
    url: '/spite/api/r2-image/uploads/reference.png',
    filename: 'reference.png',
    fetchFn: async (input, init) => {
      calls.push({ input: String(input), method: init?.method })
      if (String(input) === '/api/assets/import') {
        return new Response(JSON.stringify({ asset: { id: '2b3a6608-ff3f-45ef-a323-ec9e9e08d399' }, url: '/api/assets/2b3a6608-ff3f-45ef-a323-ec9e9e08d399/download?workspace_id=w1' }), { status: 201 })
      }
      return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })
    },
  })
  assert.equal(result.assetId, '2b3a6608-ff3f-45ef-a323-ec9e9e08d399')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input, '/spite/api/r2-image/uploads/reference.png?trust_import=1')
  assert.equal(calls[1].input, '/api/assets/import')
  assert.equal(calls[1].method, 'POST')
})

test('canonical images skip import and unavailable sources fail safely', async () => {
  let calls = 0
  const canonical = '/api/assets/2b3a6608-ff3f-45ef-a323-ec9e9e08d399/download?workspace_id=w1'
  assert.deepEqual(await importImageForTrust({ url: canonical, fetchFn: async () => { calls++; throw new Error('unused') } }), {
    assetId: '2b3a6608-ff3f-45ef-a323-ec9e9e08d399', canonicalUrl: canonical,
  })
  assert.equal(calls, 0)
  await assert.rejects(importImageForTrust({ url: '/missing.png', fetchFn: async () => new Response(null, { status: 404 }) }), /Source image is unavailable/)
})

test('trust UI is available only for workspace images', () => {
  assert.equal(trustForSeedanceView('video', { status: 'not_trusted' }), null)
  assert.equal(trustForSeedanceView('audio', { status: 'failed' }), null)
  assert.deepEqual(trustForSeedanceView('image', { status: 'not_trusted' }), {
    label: 'Not trusted for Seedance',
    action: 'Trust for Seedance',
    disabled: false,
  })
})

test('an in-flight POST disables trust before the server reports processing', () => {
  assert.deepEqual(trustForSeedanceView('image', { status: 'not_trusted' }, true), {
    label: 'Trusting for Seedance',
    action: 'Trusting…',
    disabled: true,
  })
})

test('processing and active trust states have accessible labels and no repeat action', () => {
  assert.deepEqual(trustForSeedanceView('image', { status: 'processing' }), {
    label: 'Trusting for Seedance',
    action: 'Trusting…',
    disabled: true,
  })
  assert.deepEqual(trustForSeedanceView('image', { status: 'active' }), {
    label: 'Trusted for Seedance',
    action: null,
    disabled: true,
  })
})

test('failed trust state offers a retry with safe copy', () => {
  assert.deepEqual(trustForSeedanceView('image', {
    status: 'failed',
    error: { code: 'provider-secret', message: 'raw provider response asset-123' },
  }), {
    label: 'Trust failed',
    action: 'Retry trust',
    disabled: false,
    message: 'Could not trust this image. Try again.',
  })
})

test('missing BytePlus configuration gets an actionable setup message', () => {
  assert.equal(
    safeBytePlusTrustError({ code: 'BYTEPLUS_ASSETS_NOT_CONFIGURED', message: 'internal details' }),
    'BytePlus trusted assets are not configured. Ask an administrator to complete setup.',
  )
})

test('polling runs only for a visible document and selected processing image', () => {
  assert.equal(shouldPollBytePlusTrust({ documentVisible: true, detailVisible: true, type: 'image', status: 'processing' }), true)
  assert.equal(shouldPollBytePlusTrust({ documentVisible: false, detailVisible: true, type: 'image', status: 'processing' }), false)
  assert.equal(shouldPollBytePlusTrust({ detailVisible: false, type: 'image', status: 'processing' }), false)
  assert.equal(shouldPollBytePlusTrust({ detailVisible: true, type: 'video', status: 'processing' }), false)
  assert.equal(shouldPollBytePlusTrust({ detailVisible: true, type: 'image', status: 'active' }), false)
  assert.equal(shouldPollBytePlusTrust({ detailVisible: true, type: 'image', status: 'failed' }), false)
})

test('retryable GET failures remain processing and use bounded backoff', async () => {
  const state = await requestBytePlusTrust('asset-1', 'GET', async () => new Response(
    JSON.stringify({ error: { code: 'BYTEPLUS_ASSETS_UNAVAILABLE' } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  ))
  assert.deepEqual(state, { status: 'processing' })
  assert.deepEqual(
    await requestBytePlusTrust('asset-1', 'GET', async () => { throw new TypeError('network down') }),
    { status: 'processing' },
  )
  assert.equal(bytePlusTrustPollDelay(0), 2000)
  assert.equal(bytePlusTrustPollDelay(20), 30000)
})

test('image generator and image reference nodes expose trust only while selected', () => {
  assert.match(imageNodeSource, /useImageTrust/)
  assert.match(referenceNodeSource, /useImageTrust/)
  assert.match(imageNodeSource, /workspaceAssetId: data\.workspaceAssetId/)
  assert.match(referenceNodeSource, /workspaceAssetId: data\.workspaceAssetId/)
  assert.doesNotMatch(referenceNodeSource, /workspaceAssetId: data\.workspaceAssetId \|\| data\.assetId/)
  assert.match(imageNodeSource, /enabled: Boolean\(selected\).*Boolean\(outputUrl\)/)
  assert.match(referenceNodeSource, /enabled: Boolean\(selected\).*Boolean\(thumbnail\)/)
  assert.match(nodeToolbarSource, /trustAction/)
  assert.match(nodeToolbarSource, /Trust for Seedance/)
})

test('folder image details open without a workspace-list match and canonicalize before trust', () => {
  assert.match(toolbarSource, /setSelectedGenAsset\(full \|\|/)
  assert.match(toolbarSource, /importImageForTrust/)
  assert.match(toolbarSource, /canonical_url: imported\.canonicalUrl/)
  assert.match(toolbarSource, /requestBytePlusTrust\(imported\.assetId, 'POST'\)/)
})

test('both detail layouts wire the shared trust action to the selected asset in-flight state', () => {
  assert.equal(
    toolbarSource.match(/inFlight=\{trustingAssetIds\.has\(selectedGenAsset\.id\)\}/g)?.length,
    2,
  )
  assert.match(toolbarSource, /if \(trustRequestsRef\.current\.has\(asset\.id\)\) return/)
  assert.match(toolbarSource, /trustRequestsRef\.current\.add\(asset\.id\)/)
  assert.match(toolbarSource, /trustRequestsRef\.current\.delete\(asset\.id\)/)
})

test('processing trust polling uses one recursive timeout with cleanup, not an overlapping interval', () => {
  const pollingEffect = toolbarSource.slice(
    toolbarSource.indexOf('if (!shouldPollBytePlusTrust'),
    toolbarSource.indexOf('// Listen for asset status changes'),
  )

  assert.match(pollingEffect, /await requestBytePlusTrust/)
  assert.match(pollingEffect, /window\.setTimeout\(poll, bytePlusTrustPollDelay\(attempt\)\)/)
  assert.match(pollingEffect, /window\.clearTimeout\(timeout\)/)
  assert.doesNotMatch(pollingEffect, /setInterval/)
  assert.match(pollingEffect, /if \(cancelled\) return/)
  assert.match(toolbarSource, /document\.addEventListener\('visibilitychange'/)
  assert.match(toolbarSource, /document\.hidden/)
  assert.match(pollingEffect, /bytePlusTrustPollDelay/)
})

test('trust responses update the matching list item without requiring an ID in the payload', () => {
  const assets = [
    { id: 'image-1', byteplus_trust: { status: 'not_trusted' as const } },
    { id: 'image-2', byteplus_trust: { status: 'active' as const } },
  ]

  const updated = applyBytePlusTrustState(assets, 'image-1', { status: 'processing' })

  assert.deepEqual(updated, [
    { id: 'image-1', byteplus_trust: { status: 'processing' } },
    assets[1],
  ])
  assert.equal(updated[1], assets[1])
})
