import assert from 'node:assert/strict'
import test from 'node:test'
import { createR2ImageHandler } from '../app/api/r2-image/[...path]/route'

function handlerDeps() {
  let signed = 0
  let read = 0
  return {
    counters: () => ({ signed, read }),
    deps: {
      getAuthenticatedUser: async () => ({ id: 'user-1' }) as any,
      verifyImageToken: () => false,
      getR2Client: () => ({
        send: async () => {
          read += 1
          return {
            ContentType: 'image/png',
            Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
          }
        },
      }) as any,
      getSignedUrl: async () => {
        signed += 1
        return 'https://r2.example/signed'
      },
      env: { R2_BUCKET_NAME: 'bucket' },
    },
  }
}

test('authenticated trust import streams once through same origin instead of redirecting to R2', async () => {
  const setup = handlerDeps()
  const response = await createR2ImageHandler(setup.deps)(
    new Request('https://canvas.test/api/r2-image/uploads/person.png?trust_import=1'),
    { params: Promise.resolve({ path: ['uploads', 'person.png'] }) },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(setup.counters(), { signed: 0, read: 1 })
})

test('ordinary authenticated media still redirects directly to R2', async () => {
  const setup = handlerDeps()
  const response = await createR2ImageHandler(setup.deps)(
    new Request('https://canvas.test/api/r2-image/uploads/person.png'),
    { params: Promise.resolve({ path: ['uploads', 'person.png'] }) },
  )

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://r2.example/signed')
  assert.deepEqual(setup.counters(), { signed: 1, read: 0 })
})
