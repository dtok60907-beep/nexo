'use client'

import { withBasePath, withGenerationOutputBasePath } from '@/lib/base-path'
import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { Handle, Position, NodeProps, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import { Play, CaretDown, Minus, Plus, TextT, Image as ImageIcon, CircleNotch, X, Check, ArrowsClockwise } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { NodeActionToolbar } from './node-toolbar'
import { ShotSelector, type ShotOption } from './shot-selector'
import { useSceneShots } from './use-scene-shots'
import { Lightbox } from '../lightbox'
import { AddToFolderModal } from '../add-to-folder-modal'
import { labelFromPrompt, DEFAULT_IMAGE_LABEL } from '@/lib/auto-name'
import { folderMediaLabel } from '@/lib/canvas-media-label'
import { getImageModels, getModelById, buildModelInput, type ModelConfig } from '@/lib/fal-models'
import { estimateGenerationCost, formatUSD, COST_CONFIRM_THRESHOLD_USD } from '@/lib/fal-cost'
import { resolveNodeMediaUrl } from '@/lib/node-media'
import { useNodeOwnershipLock } from '@/hooks/use-node-ownership-lock'
import { compileMentionsForModel } from '@/lib/mention-prompt'
import { useProjectFolders } from '@/hooks/use-project-folders'
import { useImageTrust } from '@/hooks/use-image-trust'
import { completeGenerationNode } from '@/lib/generation-node'
import { ConnectedInputs } from '../connected-inputs'
import { useCanvasCollaboration } from '../canvas-collaboration'
import { createLocalStateSyncGuard } from '@/lib/local-state-sync'
import { createGenerationStatusQuery, getGenerationPromptState, parseAspectRatio, resolveIncomingPrompt } from '@/lib/canvas-node-interactions'
import { GenerationFeedbackOverlay, getGenerationFeedbackState, isTerminalGenerationStatus, getTerminalGenerationToast } from './generation-feedback'

const IMAGE_MODELS = getImageModels()

type GenerationStatus = 'idle' | 'submitting' | 'in_queue' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

function ControlSelect({ 
  value, 
  options, 
  onChange,
  disabled 
}: { 
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={ref} className="nodrag nopan relative">
      <button 
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="nodrag nopan flex items-center gap-1 px-2 h-6 rounded-md bg-white/5 hover:bg-white/10 text-[10px] font-mono text-muted-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {value}
        <CaretDown size={8} weight="bold" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 bg-[#1a1d21] border border-white/10 rounded-lg py-1 z-50 min-w-[120px] shadow-xl max-h-[200px] overflow-y-auto">
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`nodrag nopan w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-white/10 transition-colors ${opt.value === value ? 'text-accent' : 'text-muted-foreground'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function HandleIcon({ icon: Icon, color, position, top, visible = true }: { 
  icon: React.ElementType
  color: string
  position: 'left' | 'right'
  top: number
  visible?: boolean 
}) {
  if (!visible) return null
  
  return (
    <div
      className="absolute flex items-center justify-center"
      style={{
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: '#111316',
        border: `1.5px solid ${color}`,
        top: top,
        transform: 'translateY(-50%)',
        [position === 'left' ? 'left' : 'right']: -12,
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      <Icon size={11} weight="bold" style={{ color }} />
    </div>
  )
}

function StatusBadge({ status, progress }: { status: GenerationStatus; progress?: number }) {
  if (status === 'idle') return null
  
  const statusConfig: Record<GenerationStatus, { label: string; color: string }> = {
    idle: { label: '', color: '' },
    submitting: { label: 'Submitting...', color: 'text-blue-400' },
    in_queue: { label: 'In Queue', color: 'text-yellow-400' },
    in_progress: { label: progress ? `${Math.round(progress * 100)}%` : 'Generating...', color: 'text-accent' },
    completed: { label: 'Done', color: 'text-green-400' },
    failed: { label: 'Failed', color: 'text-red-400' },
    cancelled: { label: 'Cancelled', color: 'text-gray-400' },
  }

  const config = statusConfig[status]

  return (
    <div className={`flex items-center gap-1.5 text-[9px] font-mono ${config.color}`}>
      {(status === 'submitting' || status === 'in_queue' || status === 'in_progress') && (
        <CircleNotch size={10} className="animate-spin" />
      )}
      {status === 'completed' && <Check size={10} weight="bold" />}
      {status === 'failed' && <X size={10} weight="bold" />}
      {config.label}
    </div>
  )
}

function ImageNodeImpl({ id, data, selected }: NodeProps) {
  const params = useParams()
  // Route segment is [id], so the param is `id` (not `projectId`).
  const projectId = params.id as string
  const nodeLock = useNodeOwnershipLock(projectId, id)
  const [modelId, setModelId] = useState((data.modelId as string) || 'nano-banana-pro')
  const [aspectRatio, setAspectRatio] = useState((data.aspectRatio as string) || '')
  const [resolution, setResolution] = useState((data.resolution as string) || '')
  // Batch count persists across reloads on image models — the user
  // commonly works in batches of 6 on Nano Banana / Flux for character
  // sheets, style sheets, etc., and re-clicking + every session is
  // friction. The user is protected by (a) the inline cost preview in
  // the Generate button tooltip, (b) the live fal balance badge in the
  // toolbar, and (c) the COST_CONFIRM_THRESHOLD on truly extreme
  // batches. Counter on the video node, in contrast, does NOT persist —
  // see comment there for the rationale.
  const [numImages, setNumImages] = useState((data.numImages as number) || 1)
  
  const [status, setStatus] = useState<GenerationStatus>('idle')
  const [progress, setProgress] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null>(resolveNodeMediaUrl(data as Record<string, unknown>) || null)
  const [generationId, setGenerationId] = useState<string | null>(null)
  // Timestamp of the most recent submission. Powers the relative-age
  // display in the right-side jobs panel.
  const [submittedAt, setSubmittedAt] = useState<number | undefined>(
    (data.submittedAt as number) || undefined,
  )
  // The exact fal queue path to poll, as told to us by the submit response.
  const [providerModel, setProviderModel] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [folderType, setFolderType] = useState<'character' | 'prop' | 'location'>('character')
  const [isRenaming, setIsRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  
  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const announcedOutputRef = useRef(outputUrl)
  const lastAnnouncedGenerationRef = useRef<string | null>(null)
  const regenerationRef = useRef(false)
  // React state updates after this event; lock synchronous repeat clicks meanwhile.
  const submitInFlightRef = useRef(false)
  // Set true to immediately stop polling (cancel / unmount), so an in-flight
  // status check can't reschedule itself or apply a late result.
  const stopRef = useRef(false)
  const { getEdges, getNodes } = useReactFlow()
  const { addEdges, addNodes, createNextShot, patchNodeData, replaceShot, updateNodeData } = useCanvasCollaboration()
  const updateNodeInternals = useUpdateNodeInternals()
  const syncGuardRef = useRef(createLocalStateSyncGuard())
  // Collaboration methods are recreated when the shared canvas snapshot changes.
  // Keep persistence wrappers stable so those renders cannot reset generation polling.
  const patchNodeDataRef = useRef(patchNodeData)
  const updateNodeDataRef = useRef(updateNodeData)
  patchNodeDataRef.current = patchNodeData
  updateNodeDataRef.current = updateNodeData
  const patchPersistedNodeData = useCallback((patch: Record<string, unknown>) => {
    if (!syncGuardRef.current.allowsPersistence()) return
    patchNodeDataRef.current(id, patch)
  }, [id])
  const updatePersistedNodeData = useCallback((updater: (currentData: Record<string, unknown>) => Record<string, unknown>) => {
    if (!syncGuardRef.current.allowsPersistence()) return
    updateNodeDataRef.current(id, updater)
  }, [id])
  const imageTrust = useImageTrust({
    url: outputUrl,
    workspaceAssetId: data.workspaceAssetId,
    filename: `${String(data.label || 'generated-image')}.png`,
    enabled: Boolean(selected) && Boolean(outputUrl) && !['submitting', 'in_queue', 'in_progress'].includes(status),
    onCanonicalized: useCallback((canonicalUrl: string, workspaceAssetId: string) => {
      setOutputUrl(canonicalUrl)
      patchPersistedNodeData({ outputUrl: canonicalUrl, workspaceAssetId })
    }, [patchPersistedNodeData]),
  })
  
  // Prompt text is read from the connected Text node at render and again
  // immediately before recovery/submission; this node never owns a prompt.
  const resolvedPrompt = resolveIncomingPrompt(id, getNodes(), getEdges())
  const promptState = getGenerationPromptState(id, getNodes(), getEdges())
  const { folders } = useProjectFolders(projectId)

  useEffect(() => {
    const finishSync = syncGuardRef.current.beginPropSync()
    setModelId((data.modelId as string) || 'nano-banana-pro')
    setAspectRatio((data.aspectRatio as string) || '')
    setResolution((data.resolution as string) || '')
    setNumImages((data.numImages as number) || 1)
    const durableStatus = data.generationStatus === 'failed'
      ? 'failed'
      : data.generationStatus === 'completed'
        ? 'completed'
        : undefined
    setStatus(durableStatus || (data.status as GenerationStatus) || ((data.outputUrl as string | undefined) ? 'completed' : 'idle'))
    setError((data.generationError as string) || (data.error as string) || null)
    setSubmittedAt((data.submittedAt as number) || undefined)
    setOutputUrl(resolveNodeMediaUrl(data as Record<string, unknown>) || null)
    queueMicrotask(finishSync)
  }, [data.aspectRatio, data.error, data.generationError, data.generationStatus, data.modelId, data.numImages, data.outputUrl, data.resolution, data.status, data.submittedAt, data.workspaceAssetId])

  useEffect(() => {
    if (outputUrl && outputUrl !== announcedOutputRef.current) {
      window.dispatchEvent(new CustomEvent('asset-status-changed'))
    }
    announcedOutputRef.current = outputUrl
  }, [outputUrl])

  const durableGenerationId = (data.lastGenerationId as string | undefined) || (data.generationId as string | undefined) || null

  // Seed initial announced generation on mount: if the node loads with a
  // terminal durable generation already present, mark it announced so we
  // don't replay its toast. If the node loads with an active generation
  // (in-progress/queued) that's a regeneration, do NOT seed it so when the
  // same id later becomes terminal it'll notify exactly once.
  useEffect(() => {
    if (durableGenerationId && isTerminalGenerationStatus(data.generationStatus)) {
      lastAnnouncedGenerationRef.current = durableGenerationId
    }
    // run only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Emit a terminal toast once per generation id when we observe a terminal
  // state. lastAnnouncedGenerationRef prevents duplicates across re-renders
  // and polling reconciliation.
  useEffect(() => {
    if (!durableGenerationId) return

    const notice = getTerminalGenerationToast({
      mediaKind: 'image',
      generationId: durableGenerationId,
      generationStatus: data.generationStatus,
      error: (data.generationError as string) || (data.error as string) || null,
      isRegeneration: regenerationRef.current,
      lastAnnouncedGenerationId: lastAnnouncedGenerationRef.current,
    })
    if (!notice) return

    lastAnnouncedGenerationRef.current = notice.generationId
    const toastId = `${id}-${notice.generationId}-terminal`
    if (notice.tone === 'success') toast.success(notice.message, { id: toastId })
    else toast.error(notice.message, { id: toastId })
  }, [data.error, data.generationError, data.generationStatus, durableGenerationId, id])

  // Repair outputs written before durable asset URLs were kept outside /spite.
  useEffect(() => {
    if (typeof data.outputUrl !== 'string' || !data.outputUrl.startsWith('/spite/api/assets/')) return
    const repaired = data.outputUrl.slice('/spite'.length)
    setOutputUrl(repaired)
    updatePersistedNodeData((currentData) => completeGenerationNode(currentData, repaired))
  }, [data.outputUrl, updatePersistedNodeData])

  // Recover a result when the provider/R2 request succeeded but the browser
  // lost the submit response before it could attach the URL to this node.
  useEffect(() => {
    const since = data.submittedAt as number | undefined
    if (outputUrl || !since || !resolvedPrompt.prompt) return
    let cancelled = false
    const params = new URLSearchParams({ projectId, type: 'image', prompt: resolvedPrompt.prompt, since: String(since) })
    fetch(withBasePath(`/api/generate/latest?${params}`))
      .then(res => res.ok ? res.json() : null)
      .then(result => {
        const url = result?.output?.url
        if (cancelled || !url) return
        const completedUrl = withGenerationOutputBasePath(url)
        setOutputUrl(completedUrl)
        setStatus('completed')
        setGenerationId(null)
        updatePersistedNodeData((currentData) => completeGenerationNode(currentData, completedUrl))
      })
      .catch(() => {})
    return () => { cancelled = true }
  // Recovery is intentionally a mount-time safety net; live jobs use submit/poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resume polling only for an active durable job. A failed/completed job can
  // retain a legacy generationId, but must never be rendered as in queue.
  useEffect(() => {
    const pending = data.generationId as string | undefined
    const active = ['queued', 'processing', 'running'].includes(String(data.generationStatus))
    if (pending && active && !generationId) {
      regenerationRef.current = Boolean(outputUrl)
      setProviderModel((data.pendingProviderModel as string) || null)
      setGenerationId(pending)
      setStatus('in_queue')
      // Restore the start-of-generation timestamp (fall back to now if
      // the page was refreshed before timestamps were tracked). Used by
      // the 10-minute soft timeout below.
      const startedAt = (data.pendingStartedAt as number | undefined) ?? Date.now()
      startTimeRef.current = startedAt
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 10-minute soft timeout — stops polling and marks failed but keeps
  // generationId on the node so the user can re-check with the button.
  const TIMEOUT_MS = 10 * 60 * 1000
  const startTimeRef = useRef<number | null>(null)
  const [resumeToken, setResumeToken] = useState(0)
  
  // Sync outputUrl TO node data when it changes (for connected nodes to read)
  useEffect(() => {
    if (!outputUrl || outputUrl === data.outputUrl) return
    patchPersistedNodeData({ outputUrl })
  }, [data.outputUrl, outputUrl, patchPersistedNodeData])

  // Get current model config
  const currentModel = useMemo(() => getModelById(modelId), [modelId])

  // Switching models toggles conditional handles (image-in). React Flow
  // caches handle positions on first measure, so without a nudge a new
  // handle's position stays stale until something else re-measures
  // (e.g. page reload) — edges drawn to those handles were saved to
  // state but their SVG path couldn't resolve and nothing was drawn.
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals, currentModel?.id, currentModel?.inputTypes])

  // Reset aspect/resolution when the USER picks a new model. Skip the
  // initial mount so saved settings on a reloaded or duplicated node aren't
  // immediately clobbered by model defaults.
  const prevModelIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!currentModel) return
    if (prevModelIdRef.current === null) {
      prevModelIdRef.current = currentModel.id
      return
    }
    if (prevModelIdRef.current !== currentModel.id) {
      if (!syncGuardRef.current.allowsPersistence()) {
        prevModelIdRef.current = currentModel.id
        return
      }
      setAspectRatio(currentModel.defaultAspectRatio)
      setResolution(currentModel.defaultResolution || '')
      prevModelIdRef.current = currentModel.id
    }
  }, [currentModel])

  const selectedShotId = data.shotId as string | undefined
  // useNodes() would re-render this component on every sibling node change
  // (prompt keystrokes, generation status updates, etc.). useSceneShots
  // subscribes only to a string signature of shot-relevant fields.
  const shots = useSceneShots(id)

  const handleShotSelect = (shotId: string) => {
    // Empty string from the selector means "unassign from this shot".
    // Storing undefined keeps the data object clean (no stray empty
    // strings ending up in exports/snapshots) and matches every other
    // code path that checks for shotId via truthiness.
    syncGuardRef.current.beginUserEdit()
    patchPersistedNodeData({ shotId: shotId || undefined })
  }

  // Take a shot over exclusively: assign it here and unassign whatever other
  // node in the SAME scene currently holds it (shotId or legacy selectedShotId).
  const handleShotReplace = (shotId: string) => {
    replaceShot(id, shotId)
  }

  const handleNewShot = () => {
    // Always create the NEXT number after the highest existing shot in the
    // scene — so shots monotonically increase (shot 99 → New Shot creates
    // shot 100). Gaps between numbers are intentional and shown as empty
    // placeholders in the timeline.
    syncGuardRef.current.beginUserEdit()
    createNextShot(id)
  }

  // Auto-name: once a generation completes, replace the default
  // "Image Generator #N" label with the first few words of the prompt.
  // User-renamed labels are left alone.
  useEffect(() => {
    if (!outputUrl) return
    const current = (data.label as string) || ''
    if (current && !DEFAULT_IMAGE_LABEL.test(current)) return
    const derived = labelFromPrompt(resolvedPrompt.prompt)
    if (!derived || derived === current) return
    patchPersistedNodeData({ label: derived })
  }, [data.label, outputUrl, patchPersistedNodeData, resolvedPrompt.prompt])

  const handleRename = () => {
    setLabelDraft((data.label as string) || '')
    setIsRenaming(true)
  }
  const handleAddToFolder = (type: 'character' | 'prop' | 'location') => {
    setFolderType(type)
    setFolderModalOpen(true)
  }
  const commitRename = () => {
    const next = labelDraft.trim()
    setIsRenaming(false)
    if (!next) return
    syncGuardRef.current.beginUserEdit()
    patchPersistedNodeData({ label: next })
  }

  // Drop the persisted in-flight job marker once a generation resolves
  // (success / failure / cancel) so a future refresh doesn't try to
  // resume a completed job.
  const clearPending = useCallback(() => {
    patchPersistedNodeData({
      pendingProvider: undefined,
      pendingProviderModel: undefined,
      pendingFalEndpoint: undefined,
      pendingStartedAt: undefined,
    })
  }, [patchPersistedNodeData])

  // Poll for status
  const pollStatus = useCallback(async (reqId: string) => {
    if (stopRef.current) return true
    // Soft timeout — bail before the next round-trip if we've been
    // polling for over 10 minutes. Keeps generationId on the node so the
    // user can re-check via the "Re-check" button.
    if (startTimeRef.current && Date.now() - startTimeRef.current > TIMEOUT_MS) {
      setStatus('failed')
      setError("Generation took over 10 min — the provider might still finish. Use 'Re-check result' to look again, or 'Cancel' to give up.")
      return true
    }
    try {
      const statusQuery = createGenerationStatusQuery({
        nodeId: id, generationId: reqId, projectId,
      })
      const response = await fetch(withBasePath(`/api/generate/status?${statusQuery}`))
      const result = await response.json()

      // Cancelled while this request was in flight — drop the result.
      if (stopRef.current) return true

      if (result.error) {
        setStatus('failed')
        setError(result.error)
        clearPending()
        return true
      }

      if (result.generationStatus === 'completed') {
        setProgress(undefined)
        // API returns { output: { images: [...], url: '...' } }
        const images: string[] = result.outputUrl ? [result.outputUrl] : []
        if (images.length) {
          const completedUrl = withGenerationOutputBasePath(images[0])
          setOutputUrl(completedUrl)
          setStatus('completed')
          setGenerationId(null)
          updatePersistedNodeData((currentData) => ({
            ...completeGenerationNode(currentData, completedUrl),
            generationId: undefined,
          }))
          clearPending()
          // For batch generations, drop the extra results as duplicate nodes
          // laid out in a neat grid next to this one.
          if (images.length > 1) {
            const extra = images.slice(1)
            const self = getNodes().find(n => n.id === id)
            const baseX = self?.position?.x ?? 0
            const baseY = self?.position?.y ?? 0
            const colGap = 360
            const rowGap = 520
            const cols = 3
            const stamp = Date.now()
            const newNodes = extra.map((url, idx) => {
              const slot = idx + 1 // slot 0 = this original node (grid top-left)
              const col = slot % cols
              const row = Math.floor(slot / cols)
              const { shotId, ...restData } = (self?.data || {}) as Record<string, unknown>
              return {
                id: `${id}-v${stamp}-${idx}`,
                type: 'imageGen',
                position: { x: baseX + col * colGap, y: baseY + row * rowGap },
                data: { ...restData, outputUrl: withGenerationOutputBasePath(url) },
              }
            })
            addNodes(newNodes as any)
            // Mirror this node's incoming connections onto each duplicate.
            const incoming = getEdges().filter(e => e.target === id)
            if (incoming.length) {
              const newEdges = newNodes.flatMap((nn, ni) =>
                incoming.map((e, ei) => ({ ...e, id: `${nn.id}-e${ei}-${stamp}-${ni}`, target: nn.id, data: { ...(e.data as Record<string, unknown> | undefined) } }))
              )
              addEdges(newEdges as any)
            }
          }
        } else {
          setStatus('failed')
          setError('Provider completed without an image URL')
          clearPending()
        }
        return true
      }

      if (result.generationStatus === 'failed') {
        setStatus('failed')
        setError(result.error || 'Generation failed')
        clearPending()
        return true
      }

      if (result.generationStatus === 'processing') {
        setStatus('in_progress')
        if (result.progress !== undefined) {
          setProgress(result.progress)
        }
      } else if (result.generationStatus === 'queued') {
        setStatus('in_queue')
      }

      return false
    } catch (err) {
      console.error('Poll error:', err)
      return false
    }
  }, [clearPending, getEdges, getNodes, id, projectId])

  // Start polling when we have a generationId. resumeToken is included as
  // a dep so a user-initiated re-check restarts the polling loop even
  // though generationId itself didn't change.
  useEffect(() => {
    if (!generationId || !currentModel) return
    stopRef.current = false

    const poll = async () => {
      if (stopRef.current) return
      const shouldStop = await pollStatus(generationId)
      if (!shouldStop && !stopRef.current) {
        pollingRef.current = setTimeout(poll, 2000)
      }
    }

    // Wait 4 seconds before first poll to let job start processing
    pollingRef.current = setTimeout(poll, 4000)

    return () => {
      stopRef.current = true
      if (pollingRef.current) {
        clearTimeout(pollingRef.current)
      }
    }
  }, [generationId, currentModel, pollStatus, resumeToken])

  // User-triggered re-check. Fires a single direct status call against
  // fal so the user sees fal's actual answer immediately — no 4-second
  // polling wait. Toast-reports the outcome so it's obvious whether the
  // job is still queued / running / done / failed. If still pending,
  // resumeToken is bumped to restart background polling for another
  // 10-minute window.
  const handleRecheck = async () => {
    if (!generationId || !currentModel) return
    const toastId = `recheck-${id}`

    startTimeRef.current = Date.now()
    setError(null)
    setStatus('in_queue')

    toast.loading('Checking the provider for this job…', { id: toastId })

    try {
      const statusQuery = createGenerationStatusQuery({
        nodeId: id, generationId, projectId,
      })
      const response = await fetch(withBasePath(`/api/generate/status?${statusQuery}`))
      const result = await response.json()

      if (result.error) {
        setStatus('failed')
        setError(result.error)
        clearPending()
        toast.error(`Provider: ${result.error}`, { id: toastId })
        return
      }

      if (result.generationStatus === 'completed') {
        const imageUrl = result.outputUrl
        if (!imageUrl) {
          setStatus('failed')
          setError('Provider completed without an image URL')
          clearPending()
          toast.error('Provider completed without an image URL', { id: toastId })
          return
        }
        const completedUrl = withGenerationOutputBasePath(imageUrl)
        setOutputUrl(completedUrl)
        setStatus('completed')
        setGenerationId(null)
        setProgress(undefined)
        updatePersistedNodeData((currentData) => ({
          ...completeGenerationNode(currentData, completedUrl),
          generationId: undefined,
        }))
        clearPending()
        toast.success('Result is ready — saved to your library.', { id: toastId })
        return
      }

      if (result.generationStatus === 'failed') {
        setStatus('failed')
        setError(result.error || 'Generation failed')
        clearPending()
        toast.error(`Provider: ${result.error || 'Generation failed'}`, { id: toastId })
        return
      }

      // Still IN_QUEUE or IN_PROGRESS — keep polling.
      if (result.generationStatus === 'processing') {
        setStatus('in_progress')
        if (result.progress !== undefined) setProgress(result.progress)
        const pct = typeof result.progress === 'number' ? ` (${Math.round(result.progress * 100)}%)` : ''
        toast.info(`fal is generating this now${pct}. Polling resumed.`, { id: toastId })
      } else {
        setStatus('in_queue')
        const posLabel = typeof result.position === 'number' ? ` (queue position ${result.position})` : ''
        toast.info(`Still in fal's queue${posLabel}. Polling resumed for 10 more minutes.`, { id: toastId })
      }
      setResumeToken(t => t + 1)
    } catch (err) {
      console.error('[recheck] error:', err)
      toast.error("Couldn't reach fal — check connection and try again.", { id: toastId })
    }
  }

  const handleGenerate = async () => {
    if (!(await nodeLock.claim())) {
      toast.error(nodeLock.error || 'Node sedang dikerjakan user lain.')
      return
    }
    const { connected, prompt: compiledPrompt } = resolveIncomingPrompt(id, getNodes(), getEdges())
    if (!connected) {
      setError('Connect a Text node first')
      return
    }
    if (!compiledPrompt) {
      setError('Enter text in the connected Text node')
      return
    }
    let connectedImageUrl: string | null = null
    const connectedImageUrls: string[] = []
    let deadImageEdges = 0

    try {
      const edges = getEdges()
      const nodes = getNodes()
      
      // Get connected image input (from image-in handle on THIS node)
      const incomingImageEdges = edges.filter(
        edge => edge.target === id && edge.targetHandle === 'image-in'
      )
      
      // Get image URL from connected image source node. Resolve through the
      // shared helper so every field a node might store media under is covered
      // (outputUrl / assetUrl / thumbnail / ...). Track any edge that resolves
      // to nothing: the cord is attached but would contribute no reference, and
      // silently generating without it wastes a paid call and returns the wrong
      // image. We refuse to submit in that case (see the guard below).
      if (incomingImageEdges.length > 0) {
        for (const imageEdge of incomingImageEdges) {
          const sourceNode = nodes.find(n => n.id === imageEdge.source)
          const sourceImageUrl = resolveNodeMediaUrl(sourceNode?.data as Record<string, unknown>)
          if (sourceImageUrl) {
            // Keep EVERY connected image, not just the first. The extras ride
            // along as reference groups below so wiring 3 images in actually
            // sends 3 (previously only the first was ever submitted).
            if (!connectedImageUrls.includes(sourceImageUrl)) connectedImageUrls.push(sourceImageUrl)
          } else {
            deadImageEdges++
          }
        }
        connectedImageUrl = connectedImageUrls[0] ?? null
      }
      
    } catch (error) {
      console.error('Error reading connected media:', error)
    }

    // Failsafe: an image cord is attached but its source has no image yet, so
    // the reference would be silently dropped. Refuse rather than burn a paid
    // generation that ignores it.
    if (deadImageEdges > 0) {
      setError(
        deadImageEdges === 1
          ? 'A connected image node has no image yet — generate or upload it first (the reference would be ignored).'
          : `${deadImageEdges} connected image nodes have no image yet — generate or upload them first (those references would be ignored).`,
      )
      return
    }

    if (!currentModel) {
      setError('Please select a model')
      return
    }

    const isReplacement = Boolean(outputUrl)
    regenerationRef.current = isReplacement
    setSubmittedAt(Date.now())
    setStatus('submitting')
    setError(null)
    setProgress(undefined)

    // For image_urls-style models, the first connected image is the primary
    // frame and additional connected image cords become reference groups.
    // How many image slots the connected cords already occupy. Models whose
    // image input is a LIST (image_urls) can carry every connected image;
    // single-slot (image_url) models can only take the first, and anything
    // extra has to ride in a dedicated referenceParam if the model has one.
    const takesMultipleImages =
      currentModel?.imageParam === 'image_urls' || !!currentModel?.referenceParam
    const extraConnected = takesMultipleImages ? connectedImageUrls.slice(1) : []
    const usedSlots =
      currentModel?.imageParam === 'image_urls'
        ? (connectedImageUrl ? 1 : 0) + extraConnected.length
        : connectedImageUrl ? 1 : 0
    const compiled = compileMentionsForModel(
      compiledPrompt,
      resolvedPrompt.mentions,
      folders,
      currentModel,
      usedSlots,
    )

    // Extra connected images go ahead of folder-mention refs (they're the more
    // explicit intent), then the mention groups keep their order.
    const allRefGroups = [
      ...extraConnected.map((u) => ({ urls: [u] })),
      ...compiled.refGroups,
    ]

    // If the model physically can't take the extras, say so instead of dropping
    // them silently — that's the exact failure this whole pass is about.
    const droppedExtras = connectedImageUrls.length - 1 - extraConnected.length
    if (droppedExtras > 0) {
      toast.warning(
        `${currentModel?.name || 'This model'} accepts one input image — ${droppedExtras} extra connected ${droppedExtras === 1 ? 'image was' : 'images were'} not sent.`,
        { duration: 7000 },
      )
    }

    try {
      // Fan out one fal job per requested image, mirroring how video-node
      // handles batch counts. This lets us blow past fal's per-request
      // num_images cap (typically 4) — `numImages` now goes up to 12.
      const body = JSON.stringify({
        kind: 'image',
        model: modelId,
        projectId,
        nodeId: id,
        prompt: compiled.prompt,
        referenceImageUrl: connectedImageUrl,
        referenceGroups: allRefGroups.length > 0 ? allRefGroups : undefined,
        settings: { aspectRatio, resolution },
      })
      const count = Math.max(1, Math.min(12, numImages))
      // Submit the N jobs ONE AT A TIME — never overlapping. Firing them in
      // parallel (even staggered by a couple hundred ms) lets the POSTs overlap
      // in flight, and the host edge rejects an "anomalous burst" with a 403
      // (our own API never returns 403 — it uses 429). Serialising the enqueue
      // calls, plus a single retry on a transient 403 / network blip, makes them
      // read as discrete user actions. The generations still run in parallel on
      // fal afterwards; only these submit calls are spaced out.
      const submitOnce = async () => {
        try {
          const res = await fetch(withBasePath('/api/generate/submit'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          const json = await res.json().catch(() => ({}))
          return { ...json, _httpStatus: res.status }
        } catch {
          return { _httpStatus: 0 }
        }
      }
      const results: Array<Awaited<ReturnType<typeof submitOnce>>> = []
      for (let i = 0; i < count; i++) {
        if (i > 0) await new Promise<void>(r => setTimeout(r, 300))
        let r = await submitOnce()
        if (!r.generationId && (r._httpStatus === 403 || r._httpStatus === 0)) {
          await new Promise<void>(res => setTimeout(res, 700))
          r = await submitOnce() // one retry for a transient edge rejection
        }
        results.push(r)
      }

      const ok = results.filter(r => r.generationId)
      const failedCount = count - ok.length
      if (ok.length === 0) {
        const firstFail = results[0]
        const status = firstFail?._httpStatus
        // ALWAYS prefer the real message. /api/generate/submit forwards fal's
        // status AND its error text verbatim, so a 401/403 here is usually fal
        // (bad key / exhausted balance / model access), not our host. Guessing a
        // cause and discarding fal's text hid the real reason for ages — don't.
        const falMsg = typeof firstFail?.error === 'string' ? firstFail.error.slice(0, 300) : ''
        // A 401 has TWO very different sources: our own middleware rejecting an
        // expired session (body is exactly "Unauthorized"), or fal rejecting the
        // key. Blaming the key for a lapsed session sends you off debugging the
        // wrong system entirely — tell them apart before saying anything.
        const sessionExpired = status === 401 && /^unauthorized$/i.test(falMsg.trim())
        const hint =
          sessionExpired ? 'your session expired — reload the page and log in again (your API key is fine)'
          : status === 401 ? 'the provider rejected its key (invalid or rotated FAL_KEY)'
          : status === 403 ? 'the provider refused the request — usually an exhausted balance or billing hold. Check provider billing.'
          : status === 503 ? 'generation disabled (GENERATION_DISABLED env var)'
          : `HTTP ${status || 'error'}`
        const reason = sessionExpired ? hint : falMsg ? `${hint} — ${falMsg}` : hint
        const message = `Failed to submit job — ${reason}`
        setStatus('failed')
        setError(message)
        toast.error(message, { id: `${id}-submission-error` })
        return
      }
      // Partial success — let the user know they got fewer outputs than
      // they asked for, so they can retry the missing N without thinking
      // it silently disappeared. Charges incurred = ok.length only.
      if (failedCount > 0) {
        toast.warning(
          `Only ${ok.length} of ${count} submissions accepted — ${failedCount} rejected (likely rate-limit). You were billed for ${ok.length}.`,
          { duration: 8000 },
        )
      }

      // Direct image providers complete synchronously. Apply the first result
      // immediately; only legacy async responses enter the polling path.
      const startedAt = Date.now()
      setGenerationId(ok[0].generationId)
      setStatus(ok[0].generationStatus === 'processing' ? 'in_progress' : 'in_queue')
      startTimeRef.current = startedAt

      patchPersistedNodeData({
        generationId: ok[0].generationId,
        generationStatus: ok[0].generationStatus,
        status: ok[0].generationStatus === 'processing' ? 'in_progress' : 'in_queue',
        error: null,
        generationError: null,
        submittedAt: startedAt,
        pendingStartedAt: startedAt,
      })

      // Extra jobs spawn duplicate image nodes in a 3-column grid that each
      // poll their own request and fill in when done.
      if (ok.length > 1) {
        const extra = ok.slice(1)
        const self = getNodes().find(nd => nd.id === id)
        const baseX = self?.position?.x ?? 0
        const baseY = self?.position?.y ?? 0
        const colGap = 360
        const rowGap = 520
        const cols = 3
        const stamp = Date.now()
        const { shotId, outputUrl: _drop, ...restData } = (self?.data || {}) as Record<string, unknown>
        const newNodes = extra.map((res, idx) => {
          const slot = idx + 1
          const col = slot % cols
          const row = Math.floor(slot / cols)
          return {
            id: `${id}-v${stamp}-${idx}`,
            type: 'imageGen',
            position: { x: baseX + col * colGap, y: baseY + row * rowGap },
            data: {
              ...restData,
              generationId: res.generationId,
              generationStatus: res.generationStatus,
              pendingStartedAt: stamp,
            },
          }
        })
        addNodes(newNodes as any)
        // Mirror this node's incoming connections onto the duplicates.
        const incoming = getEdges().filter(e => e.target === id)
        if (incoming.length) {
          const newEdges = newNodes.flatMap((nn, ni) =>
            incoming.map((e, ei) => ({ ...e, id: `${nn.id}-e${ei}-${stamp}-${ni}`, target: nn.id, data: { ...(e.data as Record<string, unknown> | undefined) } }))
          )
          addEdges(newEdges as any)
        }
      }
    } catch (err: any) {
      const message = err.message || 'Failed to submit job'
      setStatus('failed')
      setError(message)
      toast.error(message, { id: `${id}-submission-error` })
    }
  }

  // Cost-aware generate wrapper. Estimates the fal charge for the
  // current model × batch count, shows it in the button tooltip, and
  // gates handleGenerate behind a native window.confirm() when the
  // estimate crosses COST_CONFIRM_THRESHOLD_USD. Native confirm is
  // intentionally blocking + unmissable — this is a money-loss safety
  // gate, not a delight feature.
  const costEstimate = useMemo(
    () => estimateGenerationCost(currentModel, { count: numImages }),
    [currentModel, numImages],
  )
  const generateTooltip = useMemo(() => {
    if (!resolvedPrompt.connected) return 'Connect a Text node first'
    if (!resolvedPrompt.prompt) return 'Enter text in the connected Text node'
    if (!currentModel) return 'Generate image'
    const label = `Generate ${numImages} image${numImages === 1 ? '' : 's'}`
    if (!costEstimate.isKnown) return `${label}\n(price not estimated for this model)`
    return `${label}\nEstimated cost: ~${formatUSD(costEstimate.total)} (${formatUSD(costEstimate.perUnit)} each).\nReal cost depends on resolution and model load.`
  }, [currentModel, numImages, costEstimate, resolvedPrompt.connected, resolvedPrompt.prompt])
  const requestGenerate = () => {
    if (submitInFlightRef.current || (generationId && ['submitting', 'in_queue', 'in_progress'].includes(status))) return
    if (costEstimate.isKnown && costEstimate.total >= COST_CONFIRM_THRESHOLD_USD) {
      const msg =
        `You're about to submit ${numImages} ${currentModel?.name || 'image'} generation${numImages === 1 ? '' : 's'} ` +
        `to the provider.\n\n` +
        `Estimated cost: ~${formatUSD(costEstimate.total)} (${formatUSD(costEstimate.perUnit)} each).\n` +
        `Real cost depends on resolution and model load.\n\n` +
        `Press OK to confirm and spend this, or Cancel to back out.`
      if (!window.confirm(msg)) return
    }
    submitInFlightRef.current = true
    void handleGenerate().finally(() => {
      submitInFlightRef.current = false
    })
  }

  const feedbackState = getGenerationFeedbackState({ status: status === 'cancelled' ? 'idle' : status, hasOutput: Boolean(outputUrl) })
  const isGenerating = status === 'submitting' || status === 'in_queue' || status === 'in_progress'
  const isTaggedToShot = !!selectedShotId
  const feedbackFrameStyle = feedbackState.isRegenerating || feedbackState.isFailedRegeneration ? feedbackState.frameStyle : {}

  // Build options from current model's config
  const modelOptions = IMAGE_MODELS.map(m => ({ value: m.id, label: m.name }))
  const aspectOptions = currentModel?.aspectRatios.map(a => ({ value: a, label: a })) || []
  const resolutionOptions = currentModel?.resolutions?.map(r => ({ value: r, label: r })) || []

  return (
    <div
      className="relative group"
      style={{ width: 360 }}
      onPointerDownCapture={(event) => {
        if (nodeLock.owned) return
        event.preventDefault()
        event.stopPropagation()
        void nodeLock.claim()
      }}
    >
      <NodeActionToolbar
        nodeId={id}
        selected={selected}
        nodeLabel={(data.label as string) || 'Image Generator'}
        assetUrl={outputUrl || undefined}
        assetType="image"
        trustAction={outputUrl ? {
          label: imageTrust.label,
          disabled: imageTrust.disabled,
          active: imageTrust.state.status === 'active',
          processing: imageTrust.inFlight || imageTrust.state.status === 'processing',
          onClick: imageTrust.trust,
        } : undefined}
        onRename={handleRename}
        onAddToFolder={outputUrl ? handleAddToFolder : undefined}
        onViewFullscreen={outputUrl ? () => setLightboxOpen(true) : undefined}
      />

      <Lightbox
        open={lightboxOpen}
        url={outputUrl}
        type="image"
        onClose={() => setLightboxOpen(false)}
      />

      {outputUrl && (
        <AddToFolderModal
          open={folderModalOpen}
          onClose={() => setFolderModalOpen(false)}
          folderType={folderType}
          projectId={projectId}
          assetUrl={outputUrl}
          onAdded={(folder) => {
            syncGuardRef.current.beginUserEdit()
            patchPersistedNodeData({ label: folderMediaLabel(folder.name) })
          }}
        />
      )}

      {/* Shot selector badge */}
      <div className="absolute -top-8 left-0 flex items-center gap-2 z-10">
        <ShotSelector
          selectedShotId={selectedShotId}
          shots={shots}
          onSelect={handleShotSelect}
          onNewShot={handleNewShot}
          onReplace={handleShotReplace}
        />
        {isRenaming ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setIsRenaming(false)
            }}
            className="text-[10px] font-mono text-foreground bg-transparent border-b border-accent/60 outline-none min-w-[140px]"
          />
        ) : (
          <span
            onDoubleClick={handleRename}
            className="text-[10px] font-mono text-muted-foreground/60 whitespace-nowrap cursor-text hover:text-foreground transition-colors"
            title="Double-click to rename"
          >
            {(data.label as string) || 'Image Generator #1'}
          </span>
        )}
      </div>

      {/* Handles - dynamic based on model inputTypes */}
      
      {/* Text input - always shown.
          zIndex:5 puts every Handle above the card content; without it,
          drops that landed on the prompt textarea (which sits at the
          same y-coordinate as some handles) were silently rejected
          because React Flow's drop detection found the textarea before
          the handle. */}
      <Handle type="target" id="prompt-in" position={Position.Left} style={{ top: 80, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
      <HandleIcon icon={TextT} color="rgba(107,143,168,0.8)" position="left" top={80} visible />

      {/* Image input - only if model supports image input */}
      {currentModel?.inputTypes.includes('image') && (
        <>
          <Handle type="target" id="image-in" position={Position.Left} style={{ top: 180, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
          <HandleIcon icon={ImageIcon} color="rgba(96,165,250,0.8)" position="left" top={180} visible />
          <ConnectedInputs nodeId={id} handleId="image-in" side="left" top={180} label="Images" />
        </>
      )}

      {/* Image output - always shown */}
      <Handle type="source" id="image-out" position={Position.Right} style={{ top: 130, right: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
      <HandleIcon icon={ImageIcon} color="rgba(96,165,250,0.8)" position="right" top={130} visible />

      {/* Card content */}
      <div
        className="flex flex-col rounded-xl overflow-hidden transition-all duration-200"
        style={{
          background: '#0D0F12',
          border: feedbackFrameStyle.border || (isTaggedToShot
            ? '1.5px solid rgba(251,191,36,0.7)' 
            : selected 
              ? '1.5px solid rgba(107,143,168,0.85)' 
              : '1.5px solid rgba(107,143,168,0.25)'),
          boxShadow: feedbackFrameStyle.boxShadow || (isTaggedToShot
            ? '0 0 0 1px rgba(251,191,36,0.2), 0 0 20px rgba(251,191,36,0.25), 0 0 40px rgba(251,191,36,0.1)'
            : selected 
              ? '0 0 0 1px rgba(107,143,168,0.2), 0 0 24px rgba(107,143,168,0.15)' 
              : 'none'),
        }}
      >
        {/* Preview area - image displays at natural aspect ratio */}
        <div
          className="bg-[#0a0c0f] relative overflow-hidden"
          style={{ aspectRatio: String(parseAspectRatio(aspectRatio, currentModel?.defaultAspectRatio || '1:1')) }}
          onDoubleClick={() => { if (outputUrl) setLightboxOpen(true) }}
        >
          {outputUrl ? (
            <img
              src={outputUrl}
              alt="Generated"
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover cursor-zoom-in"
              onError={() => {
                // Image failed to load - could be stale URL
              }}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              {isGenerating ? (
                <>
                  <CircleNotch size={24} className="animate-spin text-accent/60" />
                  <StatusBadge status={status} progress={progress} />
                </>
              ) : (
                <span className="text-[11px] font-mono text-muted-foreground/30">No output yet</span>
              )}
            </div>
          )}
          
          <GenerationFeedbackOverlay state={feedbackState} error={error} onRetry={requestGenerate} />

          {error && !feedbackState.isFailedRegeneration && (
            <div className="absolute bottom-2 left-2 right-2 bg-red-500/20 border border-red-500/30 rounded px-2 py-1">
              <span className="text-[9px] font-mono text-red-400">{error}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 rounded-xl border border-white/10 bg-[#0D0F12] px-3 pt-2 shadow-sm">
        <div className="text-[10px] font-mono text-muted-foreground/60">
          {resolvedPrompt.connected
            ? resolvedPrompt.prompt || 'Enter text in the connected Text node'
            : 'Connect a Text node first'}
        </div>

        {/* Controls - Dynamic based on model */}
        <div className="flex items-center justify-between px-3 pb-3 gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Num images counter */}
            <div className="flex items-center gap-0.5 px-1.5 h-6 rounded-md bg-white/5 text-[10px] font-mono text-muted-foreground">
              <button 
                onClick={() => {
                  syncGuardRef.current.beginUserEdit()
                  setNumImages(n => {
                    const next = Math.max(1, n - 1)
                    patchPersistedNodeData({ numImages: next })
                    return next
                  })
                }}
                disabled={isGenerating || numImages <= 1}
                className="w-4 h-4 flex items-center justify-center hover:text-foreground disabled:opacity-30"
              >
                <Minus size={8} weight="bold" />
              </button>
              <span className="w-6 text-center">x{numImages}</span>
              <button
                onClick={() => {
                  syncGuardRef.current.beginUserEdit()
                  setNumImages(n => {
                    const next = Math.min(12, n + 1)
                    patchPersistedNodeData({ numImages: next })
                    return next
                  })
                }}
                disabled={isGenerating || numImages >= 12}
                className="w-4 h-4 flex items-center justify-center hover:text-foreground disabled:opacity-30"
              >
                <Plus size={8} weight="bold" />
              </button>
            </div>

            {/* Model selector */}
            <ControlSelect 
              value={currentModel?.name || modelId} 
              options={modelOptions}
              onChange={(value) => {
                syncGuardRef.current.beginUserEdit()
                const nextModel = getModelById(value)
                const nextAspectRatio = nextModel?.defaultAspectRatio || ''
                const nextResolution = nextModel?.defaultResolution || ''
                setModelId(value)
                setAspectRatio(nextAspectRatio)
                setResolution(nextResolution)
                patchPersistedNodeData({ modelId: value, aspectRatio: nextAspectRatio, resolution: nextResolution })
              }}
              disabled={isGenerating}
            />
            
            {/* Aspect ratio - dynamic based on model */}
            {aspectOptions.length > 0 && (
              <ControlSelect 
                value={aspectRatio || currentModel?.defaultAspectRatio || ''} 
                options={aspectOptions}
                onChange={(value) => {
                  syncGuardRef.current.beginUserEdit()
                  setAspectRatio(value)
                  patchPersistedNodeData({ aspectRatio: value })
                }}
                disabled={isGenerating}
              />
            )}
            
            {/* Resolution - only if model supports it */}
            {resolutionOptions.length > 0 && (
              <ControlSelect 
                value={resolution || currentModel?.defaultResolution || ''} 
                options={resolutionOptions}
                onChange={(value) => {
                  syncGuardRef.current.beginUserEdit()
                  setResolution(value)
                  patchPersistedNodeData({ resolution: value })
                }}
                disabled={isGenerating}
              />
            )}
          </div>
          
          {/* A submitted durable job cannot be cancelled safely: the provider may
              finish after a local cancel and leave the node/server disagreeing.
              Keep polling, and offer re-check only after a soft timeout. */}
          {isGenerating ? null : status === 'failed' && generationId ? (
            <button
              onClick={handleRecheck}
              className="px-2 h-6 rounded-full bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-white flex items-center justify-center transition-colors text-[9px] font-mono"
              title="Check the durable generation result again."
            >
              Re-check
            </button>
          ) : (
            <button
              onClick={requestGenerate}
              disabled={isGenerating || promptState.disabled}
              className="w-6 h-6 rounded-full bg-accent/20 hover:bg-accent text-accent hover:text-accent-foreground flex items-center justify-center transition-colors accent-glow disabled:opacity-50 disabled:cursor-not-allowed"
              title={generateTooltip}
            >
              <Play size={10} weight="fill" />
            </button>
          )}
        </div>
      </div>

    </div>
  )
}

export const ImageNode = memo(ImageNodeImpl)
ImageNode.displayName = 'ImageNode'
