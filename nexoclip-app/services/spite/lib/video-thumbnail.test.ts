import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCaptureVideoThumbnail } from './video-thumbnail'

test('skips workspace video URLs that redirect to CORS-blocked R2 objects', () => {
  assert.equal(shouldCaptureVideoThumbnail('/api/assets/video-1/download?workspace_id=workspace-1'), false)
  assert.equal(shouldCaptureVideoThumbnail('https://studio.example.com/api/assets/video-1/download?workspace_id=workspace-1'), false)
  assert.equal(shouldCaptureVideoThumbnail('/spite/api/assets/video-1/download?workspace_id=workspace-1'), false)
})

test('allows same-origin and data video URLs that do not use workspace redirects', () => {
  assert.equal(shouldCaptureVideoThumbnail('/spite/api/r2-image/uploads/video.mp4'), true)
  assert.equal(shouldCaptureVideoThumbnail('data:video/mp4;base64,AAAA'), true)
})
