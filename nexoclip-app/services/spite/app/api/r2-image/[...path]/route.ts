import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { NextRequest, NextResponse } from 'next/server'
import { getR2Client, verifyImageToken } from '@/lib/r2-upload'
import { getAuthenticatedUser } from '@/lib/main-session'

type R2ImageHandlerDeps = {
  getAuthenticatedUser?: typeof getAuthenticatedUser
  verifyImageToken?: typeof verifyImageToken
  getR2Client?: typeof getR2Client
  getSignedUrl?: typeof getSignedUrl
  env?: Partial<Pick<NodeJS.ProcessEnv, 'R2_BUCKET_NAME'>>
}

export function createR2ImageHandler(deps: R2ImageHandlerDeps = {}) {
  const resolveUser = deps.getAuthenticatedUser ?? getAuthenticatedUser
  const verifyToken = deps.verifyImageToken ?? verifyImageToken
  const r2Client = deps.getR2Client ?? getR2Client
  const signUrl = deps.getSignedUrl ?? getSignedUrl
  const env = deps.env ?? process.env

  return async function GET(
    request: NextRequest | Request,
    { params }: { params: Promise<{ path: string[] }> }
  ) {
    try {
    const { path } = await params

    // Two URL shapes are accepted:
    //   1. /api/r2-image/<key...>                  — browser, main-session auth
    //   2. /api/r2-image/s/<exp>/<sig>/<key...>    — fal.ai, path-token (no
    //      query string so the URL ends in the file extension and passes
    //      strict validators like Kling 3.0's `elements`).
    //   (legacy `?exp=&sig=` query-token is also still accepted as fallback.)
    let key: string
    let pathTokenOk = false
    if (path[0] === 's' && path.length >= 4) {
      const exp = path[1]
      const sig = path[2]
      key = path.slice(3).join('/')
      pathTokenOk = verifyToken(key, exp, sig)
    } else {
      key = path.join('/')
    }

    const user = await resolveUser(request)
    const { searchParams } = new URL(request.url)
    const queryTokenOk = verifyToken(key, searchParams.get('exp'), searchParams.get('sig'))
    if (!user && !pathTokenOk && !queryTokenOk) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Whether this request authenticated via an in-URL signature (path or
    // query token) rather than the main-app session. This decides cacheability:
    // a signed-token URL carries its own auth in the path/query, so the cache
    // key IS the auth and it's safe to mark public + CORS-open (fal.ai's image
    // fetcher needs both, and only ever uses signed URLs — never the cookie).
    // A session-authenticated request, by contrast, must NOT be stored in any
    // shared/CDN cache: the cache key is just the object key, so a cached copy
    // could be replayed to an unauthenticated caller. Serve those private.
    const signedAuth = pathTokenOk || queryTokenOk
    // Trusting a legacy Canvas asset needs one browser-readable same-origin copy.
    // Ordinary media must still redirect so repeated views never proxy bytes.
    const trustImport = Boolean(user) && searchParams.get('trust_import') === '1'

    // Main-app-session authenticated reads (the app's own <img>/<video> loads)
    // get a 302 to a short-lived presigned R2 URL instead of having their bytes
    // streamed back through this function. Streaming every view through the
    // function bills the full file size as Vercel "Fast Origin Transfer" on
    // EVERY load — a canvas of 30 media files reopened a few times is
    // gigabytes, enough to pause a Hobby project. Redirecting hands the
    // download straight to Cloudflare (R2 egress is free) and only a tiny
    // redirect crosses Vercel. The presigned URL is itself a time-limited
    // capability, so the bucket stays private; we mark the redirect no-store
    // so the URL is never parked in a shared cache.
    //
    // The signed-token (fal.ai) path deliberately keeps streaming below: fal's
    // image fetcher requires `Access-Control-Allow-Origin: *`, which we can
    // only guarantee from this function, not from a raw R2 presigned URL.
    if (!signedAuth && !trustImport) {
      // 1h expiry: long enough that a <video> paused then scrubbed later
      // won't hit an expired URL mid-playback, short enough to bound the
      // capability if the redirect URL ever leaks.
      const presignedUrl = await signUrl(
        r2Client(),
        new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME!, Key: key }),
        { expiresIn: 3600 },
      )
      return new NextResponse(null, {
        status: 302,
        headers: { Location: presignedUrl, 'Cache-Control': 'private, no-store' },
      })
    }

    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: key,
    })

    const response = await r2Client().send(command)
    const buffer = await response.Body?.transformToByteArray()

    if (!buffer) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Signed-token reads are public capabilities used by providers. A trust import
    // is session-authenticated and private; it streams once so browser code can
    // upload the legacy image into durable workspace storage without R2 CORS.
    const headers: Record<string, string> = signedAuth
      ? {
          'Content-Type': response.ContentType || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        }
      : {
          'Content-Type': response.ContentType || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        }
    return new NextResponse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, { headers })
  } catch (error) {
    console.error('[R2 Image Proxy] Error:', error)
    // Generic error to client (no leaking S3 error details, no caching
    // of error responses at any CDN/edge layer).
    return new NextResponse('Failed to fetch image', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    })
    }
  }
}

const GET_HANDLER = createR2ImageHandler()

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return GET_HANDLER(request, context)
}
