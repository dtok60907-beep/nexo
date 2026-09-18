'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { withBasePath } from '@/lib/base-path'
import { getOrCreateParticipantHint } from '@/lib/realtime/presence'

export function useNodeOwnershipLock(projectId: string | undefined, nodeId: string) {
  const participantId = useRef<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [isOwned, setIsOwned] = useState(false)
  const owned = useRef(false)

  const request = useCallback(async (action: 'claim' | 'heartbeat' | 'release') => {
    if (!projectId) return false
    participantId.current ??= getOrCreateParticipantHint()
    const response = await fetch(withBasePath(`/api/projects/${encodeURIComponent(projectId)}/prompt-editor-lock`), {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, nodeId, participantId: participantId.current }),
    })
    return response.ok
  }, [nodeId, projectId])

  const claim = useCallback(async () => {
    if (owned.current) return true
    try {
      owned.current = await request('claim')
      setIsOwned(owned.current)
      if (!owned.current) setError('Node sedang dikerjakan user lain.')
      else window.dispatchEvent(new CustomEvent('canvas-node-active', { detail: nodeId }))
      return owned.current
    } catch {
      setError('Lock node tidak tersedia. Coba lagi.')
      return false
    }
  }, [request])

  const release = useCallback(() => {
    if (!owned.current) return
    owned.current = false
    setIsOwned(false)
    void request('release')
  }, [request])

  useEffect(() => {
    const handleActiveNode = (event: Event) => {
      if ((event as CustomEvent<string | null>).detail !== nodeId) release()
    }
    window.addEventListener('canvas-node-active', handleActiveNode)
    return () => {
      window.removeEventListener('canvas-node-active', handleActiveNode)
      release()
    }
  }, [nodeId, release])
  useEffect(() => {
    const timer = window.setInterval(() => { if (owned.current) void request('heartbeat').then((ok) => { if (!ok) { owned.current = false; setIsOwned(false); setError('Lock node berakhir.') } }) }, 5_000)
    return () => window.clearInterval(timer)
  }, [request])

  return { claim, release, owned: isOwned, error, clearError: () => setError(null) }
}
