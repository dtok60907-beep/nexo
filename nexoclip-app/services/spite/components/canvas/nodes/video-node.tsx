'use client'

import { withBasePath, withGenerationOutputBasePath } from '@/lib/base-path'
import { Position, NodeProps, Handle, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import { useParams } from 'next/navigation'
import { Play, CaretDown, SpeakerHigh, SpeakerSlash, TextT, Image as ImageIcon, FilmStrip, CircleNotch, X, Check, ArrowsClockwise, Minus, Plus } from '@phosphor-icons/react'
import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { NodeActionToolbar } from './node-toolbar'
import { ShotSelector, type ShotOption } from './shot-selector'
import { useSceneShots } from './use-scene-shots'
import { Lightbox } from '../lightbox'
import { labelFromPrompt, DEFAULT_VIDEO_LABEL } from '@/lib/auto-name'
import { getVideoModels, getModelById, buildModelInput, type ModelConfig } from '@/lib/fal-models'
import { estimateGenerationCost, formatUSD, COST_CONFIRM_THRESHOLD_USD } from '@/lib/fal-cost'
import { resolveNodeMediaUrl } from '@/lib/node-media'
import { useNodeOwnershipLock } from '@/hooks/use-node-ownership-lock'
import { compileMentionsForModel } from '@/lib/mention-prompt'
import { useProjectFolders } from '@/hooks/use-project-folders'
import { completeGenerationNode } from '@/lib/generation-node'
import { ConnectedInputs } from '../connected-inputs'
import { captureVideoThumbnail } from '@/lib/video-thumbnail'
import { useCanvasCollaboration } from '../canvas-collaboration'
import { createLocalStateSyncGuard } from '@/lib/local-state-sync'
import { createGenerationStatusQuery, getGenerationPromptState, parseAspectRatio, resolveIncomingPrompt } from '@/lib/canvas-node-interactions'
import { GenerationFeedbackOverlay, getGenerationFeedbackState, isTerminalGenerationStatus, getTerminalGenerationToast } from './generation-feedback'

const VIDEO_MODELS = getVideoModels()

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

function VideoNodeImpl({ id, data, selected }: NodeProps) {
  const params = useParams()
  // Route segment is [id], so the param is `id` (not `projectId`).
  const projectId = params.id as string
  const nodeLock = useNodeOwnershipLock(projectId, id)
  // Upscaler mode (only meaningful when modelId is 'topaz-video-upscale').
  // 'standard' hits the plug-n-play endpoint; 'creative' hits the
  // prompt-aware variant. Persists in node data so it survives reload.
  const [upscaleMode, setUpscaleMode] = useState<'standard' | 'creative'>(
    (data.upscaleMode as 'standard' | 'creative') || 'standard',
  )
  // Depth-map colouring. Grayscale is the raw depth data and the only variant
  // safe to feed into a depth-conditioned model; the colormaps are for when you
  // want the depth pass itself as a visual element.
  const [colormap, setColormap] = useState<string>((data.colormap as string) || 'grayscale')
  const [modelId, setModelId] = useState((data.modelId as string) || 'seedance-1.5')
  const [duration, setDuration] = useState((data.duration as string) || '')
  const [aspectRatio, setAspectRatio] = useState('9:16')
  const [resolution, setResolution] = useState((data.resolution as string) || '')
  const [enableAudio, setEnableAudio] = useState((data.enableAudio as boolean) || false)
  const [enableLoop, setEnableLoop] = useState((data.enableLoop as boolean) || false)
  // Kling 2.6 voice IDs — up to 2, comma-separated in the input box.
  // User pastes IDs they generated from fal's create-voice endpoint;
  // SPITE forwards them as voice_ids on submit. They reference voices
  // in the prompt with <<<voice_1>>> / <<<voice_2>>>.
  const [voiceIds, setVoiceIds] = useState((data.voiceIds as string) || '')
  // Video models are expensive enough (Seedance ≈ $4.50 per 5-sec clip,
  // Kling Pro variants higher) that we deliberately DON'T persist the
  // counter across reloads. Every session starts at 1, and bumping it
  // up has to be a conscious action — "I want 3 Seedance shots" should
  // require typing it in, not get inherited from a forgotten setting.
  // Image counters persist (cheaper, often-used in batches of 6).
  const [numVideos, setNumVideos] = useState(1)
  
  const [status, setStatus] = useState<GenerationStatus>('idle')
  const [progress, setProgress] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null>(resolveNodeMediaUrl({ outputUrl: data.outputUrl }) || null)
  const [generationId, setGenerationId] = useState<string | null>(null)
  // Timestamp of the most recent submission. Powers the relative-age
  // display in the right-side jobs panel.
  const [submittedAt, setSubmittedAt] = useState<number | undefined>(
    (data.submittedAt as number) || undefined,
  )
  // The exact fal queue path to poll, as told to us by the submit response.
  const [providerModel, setProviderModel] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')

  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const announcedOutputRef = useRef(outputUrl)
  const lastAnnouncedGenerationRef = useRef<string | null>(null)
  const regenerationRef = useRef(false)
  // React state updates after this event; lock synchronous repeat clicks meanwhile.
  const submitInFlightRef = useRef(false)
  // Set true to immediately stop polling (cancel / unmount).
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
  
  // Prompt text is read from the connected Text node at render and again
  // immediately before submission; this node never owns a prompt.
  const resolvedPrompt = resolveIncomingPrompt(id, getNodes(), getEdges())
  const promptState = getGenerationPromptState(id, getNodes(), getEdges())
  const { folders } = useProjectFolders(projectId)

  // Check connection states fresh on each render
  let hasConnectedFirstFrame = false
  let hasConnectedReferences = false
  try {
    const edges = getEdges()
    const allIncomingEdges = edges.filter(edge => edge.target === id)
    hasConnectedFirstFrame = allIncomingEdges.some(e =>
      e.targetHandle === 'image-in' ||
      (e.sourceHandle === 'image-out' && e.targetHandle !== 'end-frame-in' && e.targetHandle !== 'reference-in' && e.targetHandle !== 'video-in')
    )
    hasConnectedReferences = allIncomingEdges.some(e => e.targetHandle === 'reference-in')
  } catch { /* ignore */ }

  // Get current model config
  const currentModel = useMemo(() => getModelById(modelId), [modelId])

  // When the model changes, the conditional handles (image-in, reference-in,
  // video-in, end-frame-in) appear or disappear. React Flow caches handle
  // positions on first measurement — without a manual nudge those caches
  // stay stale until something else re-measures (e.g., a page reload).
  // That's why edges to handles that ONLY exist for the new model were
  // sometimes added to state but not drawn: React Flow had no position
  // for the new handle yet. Tell it to re-measure whenever the handle set
  // shape changes.
  useEffect(() => {
    updateNodeInternals(id)
  }, [
    id,
    updateNodeInternals,
    currentModel?.id,
    currentModel?.inputTypes,
    currentModel?.referenceParam,
    currentModel?.category,
  ])

  useEffect(() => {
    const finishSync = syncGuardRef.current.beginPropSync()
    setUpscaleMode((data.upscaleMode as 'standard' | 'creative') || 'standard')
    setColormap((data.colormap as string) || 'grayscale')
    setModelId((data.modelId as string) || 'seedance-1.5')
    setDuration((data.duration as string) || '')
    setAspectRatio('9:16')
    setResolution((data.resolution as string) || '')
    setEnableAudio((data.enableAudio as boolean) || false)
    setEnableLoop((data.enableLoop as boolean) || false)
    setVoiceIds((data.voiceIds as string) || '')
    setNumVideos((data.numVideos as number) || 1)
    const durableStatus = data.generationStatus === 'failed'
      ? 'failed'
      : data.generationStatus === 'completed'
        ? 'completed'
        : undefined
    setStatus(durableStatus || (data.status as GenerationStatus) || ((data.outputUrl as string | undefined) ? 'completed' : 'idle'))
    setError((data.generationError as string) || (data.error as string) || null)
    setSubmittedAt((data.submittedAt as number) || undefined)
    setOutputUrl(resolveNodeMediaUrl({ outputUrl: data.outputUrl }) || null)
    queueMicrotask(finishSync)
  }, [data.aspectRatio, data.colormap, data.duration, data.enableAudio, data.enableLoop, data.error, data.generationError, data.generationStatus, data.modelId, data.numVideos, data.outputUrl, data.resolution, data.status, data.submittedAt, data.upscaleMode, data.voiceIds])

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
      mediaKind: 'video',
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

  // Repair durable asset URLs written by pre-fix bundles before rendering.
  useEffect(() => {
    if (typeof data.outputUrl !== 'string' || !data.outputUrl.startsWith('/spite/api/assets/')) return
    const repaired = data.outputUrl.slice('/spite'.length)
    setOutputUrl(repaired)
    updatePersistedNodeData((currentData) => ({
      ...completeGenerationNode(currentData, repaired),
      generationId: undefined,
    }))
  }, [data.outputUrl, updatePersistedNodeData])

  // Kling v3 references ride the image-to-video endpoint, which requires a
  // first frame. Block generation (with a clear message) when refs are
  // connected but no first frame, so the user gets a helpful error not a
  // confusing fal validation failure.
  const refsRequireFirstFrame = !!currentModel?.referenceParam && currentModel.referenceParam === 'elements' && !currentModel.referenceModel
  const blockedNoFirstFrame = refsRequireFirstFrame && hasConnectedReferences && !hasConnectedFirstFrame

  // Reset settings when the USER picks a new model. Skip the initial mount
  // so saved settings on a reloaded or duplicated node aren't immediately
  // clobbered by model defaults.
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
      setDuration(currentModel.defaultDuration || '')
      setResolution(currentModel.defaultResolution || '')
      setEnableAudio(false)
      setEnableLoop(false)
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
  // "Video Generator #N" label with the first few words of the prompt.
  // User-renamed labels are left alone.
  useEffect(() => {
    if (!outputUrl) return
    const current = (data.label as string) || ''
    if (current && !DEFAULT_VIDEO_LABEL.test(current)) return
    const derived = labelFromPrompt(resolvedPrompt.prompt)
    if (!derived || derived === current) return
    patchPersistedNodeData({ label: derived })
  }, [data.label, outputUrl, patchPersistedNodeData, resolvedPrompt.prompt])

  const handleRename = () => {
    setLabelDraft((data.label as string) || '')
    setIsRenaming(true)
  }
  const commitRename = () => {
    const next = labelDraft.trim()
    setIsRenaming(false)
    if (!next) return
    syncGuardRef.current.beginUserEdit()
    patchPersistedNodeData({ label: next })
  }

  // Capture a freeze-frame from the rendered video so the scene-shot bar
  // can show a thumbnail (an <img> can't render an mp4). Re-captures when
  // outputUrl changes (new generation); skips when the stored thumbnail
  // already matches the current outputUrl (after reload).
  useEffect(() => {
    if (!outputUrl) return
    if (data.videoThumbnailFor === outputUrl && data.videoThumbnail) return
    let cancelled = false
    captureVideoThumbnail(outputUrl).then(thumb => {
      if (cancelled || !thumb) return
      patchPersistedNodeData({ videoThumbnail: thumb, videoThumbnailFor: outputUrl })
    })
    return () => { cancelled = true }
  }, [data.videoThumbnail, data.videoThumbnailFor, outputUrl, patchPersistedNodeData])

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
      // Restore the start-of-generation timestamp (or assume now if the
      // page was refreshed and we don't have it stored). Used by the
      // 10-minute soft timeout below.
      const startedAt = (data.pendingStartedAt as number | undefined) ?? Date.now()
      startTimeRef.current = startedAt
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clear the persisted in-flight job marker when the generation resolves.
  const clearPending = useCallback(() => {
    patchPersistedNodeData({
      pendingProvider: undefined,
      pendingProviderModel: undefined,
      pendingFalEndpoint: undefined,
      pendingStartedAt: undefined,
    })
  }, [patchPersistedNodeData])

  // 10-minute soft timeout. Stops polling and marks the node failed, but
  // does NOT clear generationId — the user can click "Re-check
  // result" to poll again in case fal completed after the timeout
  // window. Resets when the user clicks re-check or triggers a new
  // generation.
  const TIMEOUT_MS = 10 * 60 * 1000
  const startTimeRef = useRef<number | null>(null)
  // Bumped to force the polling effect to restart on user-initiated re-check.
  const [resumeToken, setResumeToken] = useState(0)

  // Poll for status
  const pollStatus = useCallback(async (reqId: string) => {
    if (stopRef.current) return true
    // Soft timeout check — bail BEFORE the next round-trip so we don't
    // continue hammering fal indefinitely. The generationId stays in node
    // data so the user can manually re-check.
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
        // API returns { output: { videos: [...], url: '...' } }
        const videoUrl = result.outputUrl
        if (videoUrl) {
          const completedUrl = withGenerationOutputBasePath(videoUrl)
          setOutputUrl(completedUrl)
          setStatus('completed')
          setGenerationId(null)
          updatePersistedNodeData((currentData) => ({
            ...completeGenerationNode(currentData, completedUrl),
            generationId: undefined,
          }))
          clearPending()
        } else {
          setStatus('failed')
          setError('Provider completed without a video URL')
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
  // a dep so a user-initiated re-check (handleRecheck below) restarts the
  // polling loop even though generationId itself didn't change.
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

  // User-triggered re-check of a request that timed out (or that the
  // user wants to poll again for any reason). Fires a SINGLE direct
  // status call against fal so the user sees fal's actual answer
  // immediately — without waiting for the 4-second polling cadence.
  // Toast-reports the outcome so it's obvious whether fal genuinely
  // still has the job in queue, finished it, or errored. If the job
  // is still pending, resumeToken is bumped to restart the background
  // polling loop for another 10-minute window.
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
        const videoUrl = result.outputUrl
        if (!videoUrl) {
          setStatus('failed')
          setError('Provider completed without a video URL')
          clearPending()
          toast.error('Provider completed without a video URL', { id: toastId })
          return
        }
        const completedUrl = withGenerationOutputBasePath(videoUrl)
        setOutputUrl(completedUrl)
        setStatus('completed')
        setGenerationId(null)
        setProgress(undefined)
        updatePersistedNodeData((currentData) => completeGenerationNode(currentData, completedUrl))
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
    let connectedEndImageUrl: string | null = null
    let connectedReferenceUrls: string[] = []
    let connectedVideoUrl: string | null = null
    let connectedAudioUrl: string | null = null

    // Every media input resolves through the shared helper so no field a node
    // might store its URL under is missed. A cord that resolves to nothing is
    // counted as "dead": it looks attached but would contribute no input, and
    // generating anyway burns a paid call that ignores it.
    let deadMediaEdges = 0
    const urlOfSource = (edge: any) => {
      const sourceNode = nodes.find(n => n.id === edge.source)
      const url = resolveNodeMediaUrl(sourceNode?.data as Record<string, unknown>)
      if (!url) deadMediaEdges++
      return url
    }

    let nodes: any[] = []
    try {
      const edges = getEdges()
      nodes = getNodes()

      // End frame (its own handle) — matched first so it isn't mistaken for the first frame.
      const incomingEndFrameEdges = edges.filter(
        edge => edge.target === id && edge.targetHandle === 'end-frame-in'
      )

      // Reference images (own handle, multiple allowed).
      const incomingReferenceEdges = edges.filter(
        edge => edge.target === id && edge.targetHandle === 'reference-in'
      )

      // First frame (image-in). The image-out source fallback is for old
      // connections, but must NOT swallow end-frame / reference / video edges.
      const incomingImageEdges = edges.filter(
        edge => edge.target === id && (
          edge.targetHandle === 'image-in' ||
          (edge.sourceHandle === 'image-out' && edge.targetHandle !== 'end-frame-in' && edge.targetHandle !== 'reference-in' && edge.targetHandle !== 'video-in')
        )
      )

      // Get connected video input (from video-in handle or video-out source handle)
      const incomingVideoEdges = edges.filter(
        edge => edge.target === id && (
          edge.targetHandle === 'video-in' ||
          edge.sourceHandle === 'video-out'  // Also check source handle
        )
      )

      // Get image URL from connected first-frame source node
      if (incomingImageEdges.length > 0) {
        const url = urlOfSource(incomingImageEdges[0])
        if (url) connectedImageUrl = url
      }

      // Get end-frame URL
      if (incomingEndFrameEdges.length > 0) {
        const url = urlOfSource(incomingEndFrameEdges[0])
        if (url) connectedEndImageUrl = url
      }

      // Collect all connected reference image URLs
      connectedReferenceUrls = incomingReferenceEdges
        .map(e => urlOfSource(e))
        .filter((u): u is string => !!u)

      // Get video URL from connected video source node
      if (incomingVideoEdges.length > 0) {
        const videoEdge = incomingVideoEdges[0]
        const sourceNode = nodes.find(n => n.id === videoEdge.source)
        const sourceVideoUrl = (sourceNode?.data?.outputUrl || sourceNode?.data?.thumbnail) as string | undefined
        if (sourceVideoUrl) {
          connectedVideoUrl = sourceVideoUrl
        }
      }

      // Connected audio (Kling 2.6 only). Matches audio-in handle or
      // any edge whose source is the audio-out handle on an audio
      // reference node. Server-side will auto-create voice_id via fal.
      const incomingAudioEdges = edges.filter(
        edge => edge.target === id && (
          edge.targetHandle === 'audio-in' ||
          edge.sourceHandle === 'audio-out'
        )
      )
      if (incomingAudioEdges.length > 0) {
        const audioEdge = incomingAudioEdges[0]
        const sourceNode = nodes.find(n => n.id === audioEdge.source)
        const sourceAudioUrl = (sourceNode?.data?.thumbnail || sourceNode?.data?.outputUrl) as string | undefined
        if (sourceAudioUrl) {
          connectedAudioUrl = sourceAudioUrl
        }
      }
    } catch (error) {
      console.error('Error reading connected media:', error)
    }

    // Failsafe: a media cord is attached but its source has nothing yet, so that
    // input would be silently dropped. Refuse rather than burn a paid render.
    if (deadMediaEdges > 0) {
      setError(
        deadMediaEdges === 1
          ? 'A connected node has no image/video yet — generate or upload it first (that input would be ignored).'
          : `${deadMediaEdges} connected nodes have no image/video yet — generate or upload them first (those inputs would be ignored).`,
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

    const referenceGroups = connectedReferenceUrls.map((url) => ({ urls: [url] }))
    const compiled = compileMentionsForModel(
      compiledPrompt,
      resolvedPrompt.mentions,
      folders,
      currentModel,
      referenceGroups.length,
    )
    referenceGroups.push(...compiled.refGroups)

    // Models whose references go to a SEPARATE endpoint (Seedance 2.0's
    // reference-to-video) cannot also take a first/end frame — fal's
    // image-to-video and reference-to-video endpoints are mutually exclusive,
    // neither accepts the other's inputs. The server would silently route to
    // the reference endpoint and DROP the wired frame, which reads as "my first
    // frame got treated as a reference." Catch it here and make the user choose
    // instead of burning a generation on the wrong inputs.
    if (currentModel.referenceModel && (connectedImageUrl || connectedEndImageUrl) && referenceGroups.length > 0) {
      setError(
        `${currentModel.name} can't use a first/end frame and reference images at the same time — they're separate modes. ` +
        `Remove the @mention / wired references to keep your exact first frame, or remove the first frame to use the references.`,
      )
      setStatus('idle')
      return
    }

    try {
      const submitPrompt = compiled.prompt

      // Send RAW settings; the server builds the model-specific payload.
      const body = JSON.stringify({
        kind: 'video',
        model: modelId,
        projectId,
        nodeId: id,
        prompt: submitPrompt,
        referenceImageUrl: connectedImageUrl,
        endImageUrl: connectedEndImageUrl,
        referenceGroups: referenceGroups.length ? referenceGroups : undefined,
        settings: {
          aspectRatio,
          duration,
          resolution,
          videoUrl: connectedVideoUrl || undefined,
        },
      })

      // Each video is a separate fal job. Submit them ONE AT A TIME (never
      // overlapping) — parallel POSTs, even staggered, can overlap in flight and
      // get an "anomalous burst" 403 from the host edge (our API never returns
      // 403 — it uses 429). Serialised enqueue + one retry on a transient 403 /
      // network blip. The jobs still run in parallel on fal afterwards.
      const count = Math.max(1, Math.min(12, numVideos))
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
        // (bad key / exhausted balance / model access), not our host.
        const falMsg = typeof firstFail?.error === 'string' ? firstFail.error.slice(0, 300) : ''
        // A 401 has TWO very different sources: our own middleware rejecting an
        // expired session (body is exactly "Unauthorized"), or fal rejecting the
        // key. Tell them apart — blaming the key for a lapsed session sends you
        // debugging the wrong system.
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
      if (failedCount > 0) {
        toast.warning(
          `Only ${ok.length} of ${count} submissions accepted — ${failedCount} rejected (likely rate-limit). You were billed for ${ok.length}.`,
          { duration: 8000 },
        )
      }

      // This node tracks the first job.
      const startedAt = Date.now()
      setGenerationId(ok[0].generationId)
      setStatus(ok[0].generationStatus === 'processing' ? 'in_progress' : 'in_queue')
      startTimeRef.current = startedAt

      // Persist the in-flight job onto the node so polling can resume
      // after a page refresh. Cleared when the generation resolves.
      patchPersistedNodeData({
        generationId: ok[0].generationId,
        generationStatus: ok[0].generationStatus,
        status: ok[0].generationStatus === 'processing' ? 'in_progress' : 'in_queue',
        error: null,
        generationError: null,
        submittedAt: startedAt,
        pendingStartedAt: startedAt,
      })

      // Extra jobs become duplicate video nodes (in a grid) that each poll
      // their own request and fill in when done.
      if (ok.length > 1) {
        const extra = ok.slice(1)
        const self = getNodes().find(nd => nd.id === id)
        const baseX = self?.position?.x ?? 0
        const baseY = self?.position?.y ?? 0
        const colGap = 400
        const rowGap = 540
        const cols = 3
        const stamp = Date.now()
        const { shotId, outputUrl: _drop, ...restData } = ((self?.data || {}) as Record<string, unknown>)
        const newNodes = extra.map((res, idx) => {
          const slot = idx + 1
          const col = slot % cols
          const row = Math.floor(slot / cols)
          return {
            id: `${id}-v${stamp}-${idx}`,
            type: 'videoGen',
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
        // Mirror this node's incoming connections onto each duplicate.
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
  // current model × batch count × duration, surfaces it in the
  // button tooltip, and gates handleGenerate behind a blocking
  // window.confirm() when the estimate crosses the safety threshold.
  // Native confirm is intentional: the goal is "you cannot click
  // through without seeing the dollar amount", not aesthetics.
  const costEstimate = useMemo(
    () => estimateGenerationCost(currentModel, {
      count: numVideos,
      durationSeconds: duration ? parseInt(duration) : undefined,
    }),
    [currentModel, numVideos, duration],
  )
  const generateTooltip = useMemo(() => {
    if (!resolvedPrompt.connected) return 'Connect a Text node first'
    if (!resolvedPrompt.prompt) return 'Enter text in the connected Text node'
    if (!currentModel) return 'Generate video'
    if (blockedNoFirstFrame) {
      return `${currentModel?.name} needs a first frame when references are connected — wire an image into the blue First frame handle.`
    }
    const label = `Generate ${numVideos} video${numVideos === 1 ? '' : 's'}`
    if (!costEstimate.isKnown) return `${label}\n(price not estimated for this model)`
    return `${label}\nEstimated cost: ~${formatUSD(costEstimate.total)} (${formatUSD(costEstimate.perUnit)} each).\nReal cost depends on resolution, duration and model load.`
  }, [blockedNoFirstFrame, costEstimate, currentModel, modelId, numVideos, resolvedPrompt.connected, resolvedPrompt.prompt, upscaleMode])
  const requestGenerate = () => {
    if (submitInFlightRef.current || (generationId && ['submitting', 'in_queue', 'in_progress'].includes(status))) return
    if (costEstimate.isKnown && costEstimate.total >= COST_CONFIRM_THRESHOLD_USD) {
      const msg =
        `You're about to submit ${numVideos} ${currentModel?.name || 'video'} generation${numVideos === 1 ? '' : 's'} ` +
        `to the provider.\n\n` +
        `Estimated cost: ~${formatUSD(costEstimate.total)} (${formatUSD(costEstimate.perUnit)} each).\n` +
        `Real cost depends on resolution, duration and model load.\n\n` +
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
  const modelOptions = VIDEO_MODELS.map(m => ({ value: m.id, label: m.name }))
  const durationOptions = currentModel?.durations?.map(d => ({ value: d, label: d })) || []
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
        nodeLabel={(data.label as string) || 'Video Generator'}
        assetUrl={outputUrl || undefined}
        assetType="video"
        onRename={handleRename}
        onViewFullscreen={outputUrl ? () => setLightboxOpen(true) : undefined}
      />

      <Lightbox
        open={lightboxOpen}
        url={outputUrl}
        type="video"
        onClose={() => setLightboxOpen(false)}
      />

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
            {(data.label as string) || 'Video Generator #1'}
          </span>
        )}
      </div>

      {/* Handles - dynamic based on model inputTypes */}
      
      {/* Text input - always shown.
          NOTE on zIndex: handles are positioned absolutely as siblings of
          the card, but the card comes AFTER them in DOM order so by default
          stacks on top. That made drops at y=250 (reference-in) land on the
          prompt textarea instead of the handle and silently fail. zIndex:5
          puts every Handle above the card so React Flow's drop detection
          actually finds them. */}
      <Handle type="target" id="prompt-in" position={Position.Left} style={{ top: 80, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
      <HandleIcon icon={TextT} color="rgba(107,143,168,0.8)" position="left" top={80} visible />

      {/* First frame (blue) - only if model supports image input */}
      {currentModel?.inputTypes.includes('image') && (
        <>
          <Handle type="target" id="image-in" title="First frame" position={Position.Left} style={{ top: 150, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
          <HandleIcon icon={ImageIcon} color="rgba(96,165,250,0.8)" position="left" top={150} visible />
          <ConnectedInputs nodeId={id} handleId="image-in" side="left" top={150} label="First frame" />
        </>
      )}

      {/* End frame (amber) - video models that support a last frame */}
      {currentModel?.category === 'video' && !currentModel.id.startsWith('minimax') && (
        <>
          <Handle type="target" id="end-frame-in" title="End frame" position={Position.Left} style={{ top: 200, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
          <HandleIcon icon={ImageIcon} color="rgba(251,191,36,0.9)" position="left" top={200} visible />
          <ConnectedInputs nodeId={id} handleId="end-frame-in" side="left" top={200} label="End frame" />
        </>
      )}

      {/* Reference images (pink) - models that support subject/style refs.
          Accepts multiple image connections. */}
      {currentModel?.referenceParam && (
        <>
          <Handle type="target" id="reference-in" title="Reference image(s)" position={Position.Left} style={{ top: 250, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
          <HandleIcon icon={ImageIcon} color="rgba(236,72,153,0.9)" position="left" top={250} visible />
          <ConnectedInputs nodeId={id} handleId="reference-in" side="left" top={250} label="References" />
        </>
      )}

      {/* Video input (green) - only if model supports video-to-video */}
      {currentModel?.inputTypes.includes('video') && (
        <>
          <Handle type="target" id="video-in" title="Source video" position={Position.Left} style={{ top: 310, left: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
          <HandleIcon icon={FilmStrip} color="rgba(74,222,128,0.8)" position="left" top={310} visible />
          <ConnectedInputs nodeId={id} handleId="video-in" side="left" top={310} label="Source video" />
        </>
      )}

      {/* Video output - always shown */}
      <Handle type="source" id="video-out" position={Position.Right} style={{ top: 150, right: -12, opacity: 0, width: 24, height: 24, zIndex: 5 }} />
      <HandleIcon icon={FilmStrip} color="rgba(74,222,128,0.8)" position="right" top={150} visible />

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
        {/* Preview area */}
        <div
          className="bg-[#0a0c0f] flex items-center justify-center relative overflow-hidden"
          style={{ aspectRatio: String(parseAspectRatio(aspectRatio, currentModel?.defaultAspectRatio || '16:9')) }}
        >
          {outputUrl ? (
            <video
              src={outputUrl}
              controls
              loop={enableLoop}
              muted={!enableAudio}
              preload="metadata"
              controlsList="nofullscreen"
              onDoubleClick={(e) => {
                // The browser's built-in video controls trigger native
                // fullscreen on dblclick; suppress it so only our lightbox opens.
                e.preventDefault()
                e.stopPropagation()
                setLightboxOpen(true)
              }}
              className="w-full h-full object-cover cursor-zoom-in"
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

          {!error && blockedNoFirstFrame && (
            <div className="absolute bottom-2 left-2 right-2 bg-amber-500/20 border border-amber-500/30 rounded px-2 py-1">
              <span className="text-[9px] font-mono text-amber-300">
                {currentModel?.name} needs a first frame when references are connected. Wire an image into the blue handle.
              </span>
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

        {/* Kling 2.6 voice ID slots. Only shown for kling-2.6 since it's
            the only model on our list that supports this. Max 2 voices
            per fal docs; user references them in the prompt with
            <<<voice_1>>> and <<<voice_2>>>. Comma-separated input;
            server splits and sends as voice_ids array. */}
        {modelId === 'kling-2.6' && (
          <div className="px-3 pb-2">
            <input
              type="text"
              value={voiceIds}
              onChange={e => {
                syncGuardRef.current.beginUserEdit()
                setVoiceIds(e.target.value)
              }}
              placeholder="Voice IDs — paste from fal create-voice (max 2, comma-separated)"
              disabled={isGenerating}
              className="nodrag w-full bg-white/[0.03] border border-white/[0.06] rounded-md px-2 py-1.5 text-[11px] font-mono text-foreground/90 placeholder:text-muted-foreground/40 outline-none focus:border-accent/40 disabled:opacity-50"
            />
            <p className="text-[9px] font-mono text-muted-foreground/40 mt-1 leading-snug">
              Reference in prompt as {`<<<voice_1>>>`} / {`<<<voice_2>>>`}. Get IDs from fal&apos;s create-voice endpoint.
            </p>
          </div>
        )}

        {/* Controls - Dynamic based on model */}
        <div className="flex items-center justify-between px-3 pb-3 gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Video count counter */}
            <div className="flex items-center gap-0.5 px-1.5 h-6 rounded-md bg-white/5 text-[10px] font-mono text-muted-foreground">
              <button
                onClick={() => {
                  syncGuardRef.current.beginUserEdit()
                  setNumVideos(n => {
                    const next = Math.max(1, n - 1)
                    patchPersistedNodeData({ numVideos: next })
                    return next
                  })
                }}
                disabled={isGenerating || numVideos <= 1}
                className="w-4 h-4 flex items-center justify-center hover:text-foreground disabled:opacity-30"
              >
                <Minus size={8} weight="bold" />
              </button>
              <span className="w-6 text-center">x{numVideos}</span>
              <button
                onClick={() => {
                  syncGuardRef.current.beginUserEdit()
                  setNumVideos(n => {
                    const next = Math.min(12, n + 1)
                    patchPersistedNodeData({ numVideos: next })
                    return next
                  })
                }}
                disabled={isGenerating || numVideos >= 12}
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
                const nextAspectRatio = '9:16'
                const nextDuration = nextModel?.defaultDuration || ''
                const nextResolution = nextModel?.defaultResolution || ''
                setModelId(value)
                setAspectRatio(nextAspectRatio)
                setDuration(nextDuration)
                setResolution(nextResolution)
                setEnableAudio(false)
                patchPersistedNodeData({
                  modelId: value,
                  aspectRatio: nextAspectRatio,
                  duration: nextDuration,
                  resolution: nextResolution,
                  enableAudio: false,
                })
              }}
              disabled={isGenerating}
            />

            {/* Topaz mode toggle — only when the upscaler is selected. */}
            {modelId === 'topaz-video-upscale' && (
              <ControlSelect
                value={upscaleMode === 'creative' ? 'Creative' : 'Standard'}
                options={[
                  { value: 'standard', label: 'Standard' },
                  { value: 'creative', label: 'Creative' },
                ]}
                onChange={(v) => {
                  syncGuardRef.current.beginUserEdit()
                  setUpscaleMode(v as 'standard' | 'creative')
                  patchPersistedNodeData({ upscaleMode: v })
                }}
                disabled={isGenerating}
              />
            )}

            {/* Depth colouring — only for the depth pass. Grayscale IS the raw
                depth data (and the only one a depth-conditioned model can read
                correctly); the colormaps are display-only. */}
            {modelId === 'depth-anything-video' && (
              <ControlSelect
                value={colormap === 'grayscale' ? 'Grayscale (recommended)' : colormap}
                options={[
                  { value: 'grayscale', label: 'Grayscale (recommended)' },
                  { value: 'turbo', label: 'Turbo' },
                  { value: 'inferno', label: 'Inferno' },
                  { value: 'magma', label: 'Magma' },
                  { value: 'viridis', label: 'Viridis' },
                ]}
                onChange={(value) => {
                  syncGuardRef.current.beginUserEdit()
                  setColormap(value)
                  patchPersistedNodeData({ colormap: value })
                }}
                disabled={isGenerating}
              />
            )}

            {/* Duration - only if model supports it */}
            {durationOptions.length > 0 && (
              <ControlSelect 
                value={duration || currentModel?.defaultDuration || ''} 
                options={durationOptions}
                onChange={(value) => {
                  syncGuardRef.current.beginUserEdit()
                  setDuration(value)
                  patchPersistedNodeData({ duration: value })
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
            
            {/* Audio toggle - only if model supports audio generation */}
            {currentModel?.supportsAudio && (
              <button
                onClick={() => {
                  syncGuardRef.current.beginUserEdit()
                  setEnableAudio(a => {
                    const next = !a
                    patchPersistedNodeData({ enableAudio: next })
                    return next
                  })
                }}
                disabled={isGenerating}
                className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors disabled:opacity-50 ${
                  enableAudio ? 'bg-accent/20 text-accent' : 'bg-white/5 hover:bg-white/10 text-muted-foreground'
                }`}
                title="Generate with audio"
              >
                {enableAudio
                  ? <SpeakerHigh size={11} weight="fill" />
                  : <SpeakerSlash size={11} weight="thin" />
                }
              </button>
            )}
            
            {/* Loop toggle - only if model supports loop */}
            {currentModel?.supportsLoop && (
              <button
                onClick={() => {
                  syncGuardRef.current.beginUserEdit()
                  setEnableLoop(l => {
                    const next = !l
                    patchPersistedNodeData({ enableLoop: next })
                    return next
                  })
                }}
                disabled={isGenerating}
                className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors disabled:opacity-50 ${
                  enableLoop ? 'bg-accent/20 text-accent' : 'bg-white/5 hover:bg-white/10 text-muted-foreground'
                }`}
                title="Generate looping video"
              >
                <ArrowsClockwise size={11} weight={enableLoop ? 'fill' : 'thin'} />
              </button>
            )}
          </div>
          
          {/* Submitted durable jobs cannot be safely cancelled locally; keep
              their node state aligned with the provider until completion. */}
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
              disabled={isGenerating || blockedNoFirstFrame || promptState.disabled}
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

export const VideoNode = memo(VideoNodeImpl)
VideoNode.displayName = 'VideoNode'
