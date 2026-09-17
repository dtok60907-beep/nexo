'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bytePlusTrustPollDelay,
  importImageForTrust,
  requestBytePlusTrust,
  safeBytePlusTrustError,
  resolveWorkspaceAssetId,
  workspaceAssetDownloadUrl,
  workspaceAssetIdFromUrl,
  type BytePlusTrustState,
} from '@/lib/byteplus-trust'

interface UseImageTrustOptions {
  url?: string | null
  filename?: string
  workspaceAssetId?: unknown
  enabled?: boolean
  onCanonicalized?: (canonicalUrl: string, assetId: string) => void
}

export function useImageTrust({
  url,
  filename,
  workspaceAssetId,
  enabled = true,
  onCanonicalized,
}: UseImageTrustOptions) {
  const [assetId, setAssetId] = useState<string | null>(() => resolveWorkspaceAssetId(url, workspaceAssetId))
  const [state, setState] = useState<BytePlusTrustState>({ status: 'not_trusted' })
  const [inFlight, setInFlight] = useState(false)
  const requestRef = useRef(false)
  const onCanonicalizedRef = useRef(onCanonicalized)
  onCanonicalizedRef.current = onCanonicalized

  useEffect(() => {
    const urlAssetId = workspaceAssetIdFromUrl(url)
    const nextAssetId = resolveWorkspaceAssetId(url, workspaceAssetId)
    setAssetId(nextAssetId)
    setState({ status: 'not_trusted' })
    if (!enabled || !nextAssetId) return

    let cancelled = false
    requestBytePlusTrust(nextAssetId, 'GET')
      .then(next => {
        if (cancelled) return
        setState(next)
        if (next.status === 'active' && !urlAssetId) {
          onCanonicalizedRef.current?.(workspaceAssetDownloadUrl(nextAssetId), nextAssetId)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [enabled, url, workspaceAssetId])

  const trust = useCallback(async () => {
    if (!enabled || !url || requestRef.current || state.status === 'processing' || state.status === 'active') return
    requestRef.current = true
    setInFlight(true)
    try {
      const knownAssetId = resolveWorkspaceAssetId(url, workspaceAssetId)
      const imported = knownAssetId
        ? { assetId: knownAssetId, canonicalUrl: workspaceAssetDownloadUrl(knownAssetId) }
        : await importImageForTrust({ url, filename })
      setAssetId(imported.assetId)
      if (imported.canonicalUrl !== url) onCanonicalizedRef.current?.(imported.canonicalUrl, imported.assetId)
      setState(await requestBytePlusTrust(imported.assetId, 'POST'))
    } catch (error) {
      setState({
        status: 'failed',
        error: { code: error instanceof Error ? 'IMAGE_IMPORT_FAILED' : 'UNKNOWN' },
      })
    } finally {
      requestRef.current = false
      setInFlight(false)
    }
  }, [enabled, filename, state.status, url, workspaceAssetId])

  useEffect(() => {
    if (!assetId || state.status !== 'processing') return
    let cancelled = false
    let attempt = 0
    let timeout: ReturnType<typeof setTimeout>

    const poll = async () => {
      if (document.hidden) {
        timeout = setTimeout(poll, bytePlusTrustPollDelay(attempt))
        return
      }
      try {
        const next = await requestBytePlusTrust(assetId, 'GET')
        if (cancelled) return
        setState(next)
        if (next.status !== 'processing') return
      } catch {
        if (cancelled) return
      }
      attempt += 1
      timeout = setTimeout(poll, bytePlusTrustPollDelay(attempt))
    }

    timeout = setTimeout(poll, bytePlusTrustPollDelay(attempt))
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [assetId, state.status])

  const label = state.status === 'active'
    ? 'Trusted for Seedance'
    : state.status === 'processing' || inFlight
      ? 'Trusting for Seedance'
      : state.status === 'failed'
        ? `Retry trust: ${safeBytePlusTrustError(state.error)}`
        : 'Trust for Seedance'

  return {
    state,
    inFlight,
    trust,
    label,
    disabled: !enabled || !url || inFlight || state.status === 'processing' || state.status === 'active',
  }
}
