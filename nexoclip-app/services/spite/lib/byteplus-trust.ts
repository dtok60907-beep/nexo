export type BytePlusTrustStatus = 'not_trusted' | 'processing' | 'active' | 'failed'

export interface BytePlusTrustState {
  status: BytePlusTrustStatus
  error?: { code?: string; message?: string }
}

const WORKSPACE_ASSET_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const WORKSPACE_ASSET_ID = new RegExp(`^${WORKSPACE_ASSET_ID_SOURCE}$`, 'i')
const WORKSPACE_ASSET_PATH = new RegExp(`^/api/assets/(${WORKSPACE_ASSET_ID_SOURCE})/download(?:\\?|$)`, 'i')

export function workspaceAssetIdFromUrl(value: string | null | undefined) {
  if (!value || /^\s*asset:\/\//i.test(value)) return null
  try {
    return new URL(value, 'https://canvas.invalid').pathname.match(WORKSPACE_ASSET_PATH)?.[1] ?? null
  } catch {
    return null
  }
}

export function resolveWorkspaceAssetId(
  url: string | null | undefined,
  persistedAssetId: unknown,
) {
  return workspaceAssetIdFromUrl(url)
    ?? (typeof persistedAssetId === 'string' && WORKSPACE_ASSET_ID.test(persistedAssetId) ? persistedAssetId : null)
}

export function trustImportSourceUrl(url: string) {
  try {
    const parsed = new URL(url, 'https://canvas.invalid')
    if (!/^\/(?:spite\/)?api\/r2-image\//.test(parsed.pathname)) return url
    parsed.searchParams.set('trust_import', '1')
    return /^[a-z][a-z\d+.-]*:\/\//i.test(url)
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

export async function importImageForTrust({
  url,
  filename = 'canvas-image.png',
  fetchFn = fetch,
}: {
  url: string
  filename?: string
  fetchFn?: typeof fetch
}): Promise<{ assetId: string; canonicalUrl: string }> {
  const existingId = workspaceAssetIdFromUrl(url)
  if (existingId) return { assetId: existingId, canonicalUrl: url }

  const source = await fetchFn(trustImportSourceUrl(url))
  const contentType = source.headers.get('content-type')?.split(';')[0]?.trim() || ''
  if (!source.ok || !contentType.startsWith('image/')) throw new Error('Source image is unavailable')
  const form = new FormData()
  form.append('file', new File([await source.blob()], filename, { type: contentType }))
  const imported = await fetchFn('/api/assets/import', { method: 'POST', body: form })
  const payload = await imported.json().catch(() => ({})) as { asset?: { id?: string }; url?: string }
  const assetId = payload.asset?.id
  if (!imported.ok || !assetId || !payload.url || workspaceAssetIdFromUrl(payload.url) !== assetId) {
    throw new Error('Could not register this image')
  }
  return { assetId, canonicalUrl: payload.url }
}

export function bytePlusTrustUrl(assetId: string) {
  return `/api/assets/${encodeURIComponent(assetId)}/byteplus-trust`
}

export function safeBytePlusTrustError(error?: { code?: string; message?: string }) {
  return error?.code === 'BYTEPLUS_ASSETS_NOT_CONFIGURED'
    ? 'BytePlus trusted assets are not configured. Ask an administrator to complete setup.'
    : 'Could not trust this image. Try again.'
}

export function trustForSeedanceView(type: string, state: BytePlusTrustState, inFlight = false) {
  if (type !== 'image') return null

  if (inFlight || state.status === 'processing') {
    return { label: 'Trusting for Seedance', action: 'Trusting…', disabled: true }
  }
  if (state.status === 'active') {
    return { label: 'Trusted for Seedance', action: null, disabled: true }
  }
  if (state.status === 'failed') {
    return {
      label: 'Trust failed',
      action: 'Retry trust',
      disabled: false,
      message: safeBytePlusTrustError(state.error),
    }
  }
  return { label: 'Not trusted for Seedance', action: 'Trust for Seedance', disabled: false }
}

export function bytePlusTrustPollDelay(attempt: number) {
  return Math.min(30_000, 2_000 * (2 ** Math.max(0, attempt)))
}

export function shouldPollBytePlusTrust({
  documentVisible = true,
  detailVisible,
  type,
  status,
}: {
  documentVisible?: boolean
  detailVisible: boolean
  type?: string
  status?: BytePlusTrustStatus
}) {
  return documentVisible && detailVisible && type === 'image' && status === 'processing'
}

export function mergeAssetPreservingBytePlusTrust<T extends { id: string; byteplus_trust?: BytePlusTrustState }>(
  current: T,
  refreshed: T,
): T {
  return refreshed.byteplus_trust || !current.byteplus_trust
    ? refreshed
    : { ...refreshed, byteplus_trust: current.byteplus_trust }
}

export function applyBytePlusTrustState<T extends { id: string; byteplus_trust?: BytePlusTrustState }>(
  assets: T[] | undefined,
  assetId: string,
  state: BytePlusTrustState,
) {
  return assets?.map(asset => asset.id === assetId ? { ...asset, byteplus_trust: state } : asset)
}

export async function requestBytePlusTrust(
  assetId: string,
  method: 'GET' | 'POST',
  fetchFn: typeof fetch = fetch,
): Promise<BytePlusTrustState> {
  let response: Response
  try {
    response = await fetchFn(bytePlusTrustUrl(assetId), { method })
  } catch {
    return method === 'GET' ? { status: 'processing' } : { status: 'failed' }
  }
  const payload = await response.json().catch(() => ({})) as {
    status?: BytePlusTrustStatus
    error?: { code?: string; message?: string }
  }
  if (!response.ok) {
    if (method === 'GET' && ([408, 409, 429].includes(response.status) || response.status >= 500)) {
      return { status: 'processing' }
    }
    return { status: 'failed', error: { code: payload.error?.code } }
  }
  if (!['not_trusted', 'processing', 'active', 'failed'].includes(payload.status ?? '')) {
    return { status: 'failed' }
  }
  return { status: payload.status!, error: payload.error && { code: payload.error.code } }
}
