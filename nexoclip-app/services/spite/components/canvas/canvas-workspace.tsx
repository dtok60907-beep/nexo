'use client'

import { withBasePath } from '@/lib/base-path'
import { uploadedMediaLabel } from '@/lib/canvas-media-label'
import {
  createInvocationTimeRuntimeControls,
  getCanvasRuntimeCapabilities,
  type CanvasRuntimeControls,
} from '@/lib/canvas-runtime-ui'
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  useViewport,
  SelectionMode,
  PanOnScrollMode,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import { ScissorsEdge } from './edges/scissors-edge'
import {
  getConnectorAnimation,
  CONNECTOR_ANIMATION_EVENT,
  type ConnectorAnimation,
} from '@/lib/connector-animation'
import '@xyflow/react/dist/style.css'
import { useRealtimeCanvas } from '@/hooks/use-realtime-canvas'
import {
  createLocalPresenceSnapshot,
  createPresenceController,
  getOrCreateParticipantHint,
  presenceSnapshotNeedsPublish,
  projectRemotePresence,
  type RemotePresencePeer,
} from '@/lib/realtime/presence'
import {
  filterSelectedNodeIdsToVisible,
  reconcileSelectedNodeIds,
} from '@/lib/canvas-selection'
import { CanvasToolbar } from './canvas-toolbar'
import { nodeHasNoMedia } from '@/lib/node-media'
import { OnboardingTour } from '@/components/onboarding/use-onboarding-tour'
import { JobsPanel } from './jobs-panel'
import { LeftToolbar, type Asset } from './left-toolbar'
import { BottomBar } from './bottom-bar'
import { SceneTimeline, type Shot } from './scene-timeline'
import { AlignmentGuides, computeAlignmentGuides } from './alignment-guides'
import { MapTrifold, X } from '@phosphor-icons/react'
import { AddNodeMenu } from './add-node-menu'
import { ImageNode } from './nodes/image-node'
import { VideoNode } from './nodes/video-node'
import { PromptNode } from './nodes/prompt-node'
import { ReferenceNode } from './nodes/reference-node'
import { CommentNode } from './nodes/comment-node'
import { StickerNode, getLastSticker } from './nodes/sticker-node'
import { CompressNode } from './nodes/compress-node'
import { RealtimePresenceOverlay } from './realtime-presence'
import { CanvasCollaborationProvider } from './canvas-collaboration'
import { useCanvasCollaboration } from './canvas-collaboration'
import { resolveFollowTarget } from '@/lib/canvas-node-interactions'
import { selectLegacyNoteDeletionIds } from '@/lib/legacy-notes'

const NODE_TYPES: NodeTypes = {
  imageGen: ImageNode,
  videoGen: VideoNode,
  prompt: PromptNode,
  reference: ReferenceNode,
  comment: CommentNode,
  sticker: StickerNode,
  compress: CompressNode,
}

const EDGE_TYPES: EdgeTypes = {
  scissors: ScissorsEdge,
}

// Stable style reference for every cord. Inlining `{ stroke: ... }` in the
// edge map gave each edge a new style object on every recompute, which defeats
// React Flow's edge memoization and re-renders all edges. One shared object
// keeps the identity stable.
const EDGE_STYLE = { stroke: '#aec3d2' } as const
const DEFAULT_EDGE_OPTIONS = {
  type: 'scissors',
  style: EDGE_STYLE,
  animated: false,
} as const

// Restores AND persists the viewport (pan + zoom) per-project via localStorage,
// so a project reopens exactly where you left it. Lives in its own leaf so that
// subscribing to viewport changes re-renders ONLY this component each pan/zoom
// frame — not the entire canvas workspace.
//
// Restore happens on mount (and on project switch), BEFORE the canvas data
// finishes loading. This is the important bit: the old code restored only after
// the async canvas fetch, so on a big canvas (slow load) the throttled save
// below fired first and wrote the default {0,0,1} over the real saved viewport,
// and you always landed back at the origin. Restoring up front — and refusing
// to save until it's done — closes that race.
function ViewportPersistor({ projectId }: { projectId: string | undefined }) {
  const { setViewport } = useReactFlow()
  const viewport = useViewport()
  const readyRef = useRef(false)

  useEffect(() => {
    readyRef.current = false
    if (!projectId) return
    try {
      const raw = localStorage.getItem(`frame-viewport-${projectId}`)
      if (raw) {
        const vp = JSON.parse(raw)
        if (typeof vp?.x === 'number' && typeof vp?.y === 'number' && typeof vp?.zoom === 'number') {
          setViewport(vp)
        }
      }
    } catch {}
    // Saves are allowed only after the restore has been applied, so the initial
    // default viewport can never be written back over the saved one.
    readyRef.current = true
  }, [projectId, setViewport])

  useEffect(() => {
    if (!projectId || !readyRef.current) return
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          `frame-viewport-${projectId}`,
          JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
        )
      } catch {}
    }, 400)
    return () => clearTimeout(t)
  }, [projectId, viewport.x, viewport.y, viewport.zoom])

  return null
}

let nodeCount = 1
function makeId() { return `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

let assetCount = 1
function makeAssetId() { return `asset-${assetCount++}` }

// Connection type validation rules
const CONNECTION_RULES: Record<string, string[]> = {
  'prompt-out': ['prompt-in'], // shared text-input handle on Prompt, Image, and Video nodes
  'image-out': ['image-in', 'end-frame-in', 'reference-in'],
  'video-out': ['video-in'],
  // Audio reference → Kling 2.6 voice input. Without this the audio-out
  // handle had no allowed target, so the edge was rejected and the whole
  // voice-cloning flow was unreachable.
  'audio-out': ['audio-in'],
}

// Human-readable names for handles
const HANDLE_NAMES: Record<string, string> = {
  'prompt-out': 'Text output',
  'prompt-in': 'Text input',
  'image-out': 'Image output',
  'image-in': 'First frame / image input',
  'end-frame-in': 'End frame',
  'reference-in': 'Reference image',
  'video-out': 'Video output',
  'video-in': 'Video input',
  'audio-out': 'Audio output',
  'audio-in': 'Voice reference audio',
}

// Validate connection rules
function isValidConnection(connection: Connection | Edge): boolean {
  const { sourceHandle, targetHandle } = connection
  if (!sourceHandle || !targetHandle) return false
  const allowedTargets = CONNECTION_RULES[sourceHandle]
  return allowedTargets?.includes(targetHandle) ?? false
}

// Get rejection reason for invalid connections
function getConnectionError(sourceHandle: string | null, targetHandle: string | null): string {
  if (!sourceHandle || !targetHandle) return 'Invalid connection'
  const sourceName = HANDLE_NAMES[sourceHandle] || sourceHandle
  const targetName = HANDLE_NAMES[targetHandle] || targetHandle
  return `Cannot connect ${sourceName} to ${targetName}`
}

function makeNode(
  type: string,
  position: { x: number; y: number },
  label?: string,
  sceneId?: string,
  initialData?: Record<string, any>,
) {
  const count = nodeCount++
  const labels: Record<string, string> = {
    imageGen: `Image Generator #${count}`,
    videoGen: `Video Generator #${count}`,
    prompt: `Prompt #${count}`,
    reference: `Reference Asset #${count}`,
    compress: `Compress #${count}`,
    comment: '',
    sticker: '',
  }
  return {
    id: makeId(),
    type,
    position,
    data: {
      label: label || labels[type] || type,
      sceneId: sceneId || 'scene-1',
      thumbnail: undefined as string | undefined,
      isUploading: false,
      uploadError: false,
      // Spread initialData last so callers (e.g. menu presets) can
      // override fields like `modelId` without us clobbering them.
      ...(initialData || {}),
    } as Record<string, any>,
  }
}

const INITIAL_ASSETS: Asset[] = []

// Clipboard buffer — lives outside component so it persists across re-renders
let clipboardNodes: Node[] = []

// Ghost sticker that follows the cursor during placement
function StickerGhost({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
    const onLeave = () => setPos(null)
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [containerRef])

  if (!pos) return null

  return (
    <div
      className="absolute pointer-events-none z-50 select-none"
      style={{
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -50%)',
        fontSize: 32,
        lineHeight: 1,
        filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.5))',
      }}
    >
      {getLastSticker()}
    </div>
  )
}

function LegacyNoteCleanup() {
  const { allNodes, deleteNodes } = useCanvasCollaboration()
  const scheduledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const nextIds = selectLegacyNoteDeletionIds(allNodes as any, scheduledRef.current)
    if (nextIds.length > 0) {
      // Batch delete through the authoritative collaborative command
      deleteNodes(nextIds)
    }
  }, [allNodes, deleteNodes])
  return null
}

function CanvasInner({ projectId }: { projectId: string }) {
  const realtime = useRealtimeCanvas(projectId)
  const persistenceStatus = realtime.persistenceStatus
  const { allowDocumentMutation } = getCanvasRuntimeCapabilities(persistenceStatus)
  const readOnly = !allowDocumentMutation
  const runtimeStatusRef = useRef(persistenceStatus)
  runtimeStatusRef.current = persistenceStatus
  const runtimeControlsRef = useRef<CanvasRuntimeControls>({
    commands: realtime.commands,
    undo: realtime.undo,
    redo: realtime.redo,
  })
  runtimeControlsRef.current = {
    commands: realtime.commands,
    undo: realtime.undo,
    redo: realtime.redo,
  }
  const guardedRuntimeControls = useMemo(
    () => createInvocationTimeRuntimeControls(runtimeControlsRef, runtimeStatusRef),
    [],
  )
  const {
    nodes,
    edges,
    allNodes,
    projectName,
    scenes,
    activeSceneId,
    peers: realtimePeers,
    awareness,
  } = realtime
  const { commands, undo, redo } = guardedRuntimeControls
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const presenceControllerRef = useRef<ReturnType<typeof createPresenceController> | null>(null)
  const selectedSceneNodeIdsRef = useRef<string[]>([])
  const [presenceNow, setPresenceNow] = useState(() => Date.now())
  // Connector-animation preference (Settings → Performance). Read on mount and
  // kept live via the broadcast event so toggling it reflects without reload.
  const [connectorAnim, setConnectorAnim] = useState<ConnectorAnimation>('auto')
  useEffect(() => {
    setConnectorAnim(getConnectorAnimation())
    const onChange = (e: Event) =>
      setConnectorAnim((e as CustomEvent<ConnectorAnimation>).detail)
    window.addEventListener(CONNECTOR_ANIMATION_EVENT, onChange)
    return () => window.removeEventListener(CONNECTOR_ANIMATION_EVENT, onChange)
  }, [])
  // React Flow's separate hook for forcing a node's handle re-measurement.
  // Declared here near the top because onConnect (below) depends on it.
  const updateNodeInternals = useUpdateNodeInternals()
  const viewport = useViewport()

  // Asset management
  const [assets, setAssets] = useState<Asset[]>(INITIAL_ASSETS)

  // History panel state (for generations)
  const [showHistory, setShowHistory] = useState(false)
  // Right-side jobs panel: open/close state lives here so the panel
  // survives canvas re-renders and stays open while the user pans/zooms.
  const [jobsPanelOpen, setJobsPanelOpen] = useState(false)
  // Count of jobs currently running on this canvas — used to show a
  // small accent dot on the toolbar's Jobs button so the user knows
  // something is in flight even when the panel is closed.
  const activeJobCount = useMemo(
    () =>
      allNodes.filter(n => {
        if (n.type !== 'imageGen' && n.type !== 'videoGen') return false
        const s = (n.data as any)?.status as string | undefined
        return s === 'submitting' || s === 'in_queue' || s === 'in_progress'
      }).length,
    [allNodes],
  )

  // Active tool state
  const [activeTool, setActiveTool] = useState<'select' | 'cut' | 'sticker' | 'comment'>('select')

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPresenceNow(Date.now())
    }, 1_000)

    return () => {
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!awareness) {
      presenceControllerRef.current?.destroy()
      presenceControllerRef.current = null
      return
    }

    const controller = createPresenceController({
      awareness,
      participantId: getOrCreateParticipantHint(),
    })

    const syncPresenceSnapshot = () => {
      const snapshot = createLocalPresenceSnapshot(
        selectedSceneNodeIdsRef.current,
        document.activeElement,
      )
      if (!presenceSnapshotNeedsPublish(awareness.getLocalState?.(), snapshot)) {
        return
      }

      controller.publishSelection(snapshot.selection.nodeIds)
      controller.publishEditing(snapshot.editing?.nodeId ?? null)
    }

    presenceControllerRef.current = controller
    controller.publishScene(activeSceneId)
    awareness.on?.('change', syncPresenceSnapshot)
    awareness.on?.('update', syncPresenceSnapshot)
    syncPresenceSnapshot()

    return () => {
      awareness.off?.('change', syncPresenceSnapshot)
      awareness.off?.('update', syncPresenceSnapshot)
      controller.publishCursor(null)
      controller.publishEditing(null)
      controller.publishSelection([])
      controller.stopDragLock()
      controller.destroy()
      if (presenceControllerRef.current === controller) {
        presenceControllerRef.current = null
      }
    }
  }, [awareness])

  useEffect(() => {
    presenceControllerRef.current?.publishScene(activeSceneId)
  }, [activeSceneId])

  useEffect(() => {
    const loadData = async () => {
      try {
        const assetsResponse = await fetch(withBasePath(`/api/projects/${projectId}/assets`))
        if (assetsResponse.ok) {
          const loadedAssets = await assetsResponse.json()
          setAssets(loadedAssets)
        }
      } catch (error) {
        console.error('Error loading data:', error)
      }
    }

    loadData()
  }, [projectId])

  useEffect(() => {
    const visibleIds = new Set(nodes.map((node) => node.id))
    setSelectedNodeIds((previous) => filterSelectedNodeIdsToVisible(previous, visibleIds))
  }, [nodes])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const selectChanges = changes.filter((change) => change.type === 'select')
    if (selectChanges.length > 0) {
      const visibleNodeIds = new Set(nodes.map((node) => node.id))
      setSelectedNodeIds((previous) =>
        reconcileSelectedNodeIds(previous, selectChanges, visibleNodeIds),
      )
    }

    const durableChanges = changes.filter((change) => change.type !== 'select')
    if (!allowDocumentMutation || durableChanges.length === 0) {
      return
    }

    commands.applyNodeChanges(durableChanges)
  }, [allowDocumentMutation, commands, nodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const durableChanges = changes.filter((change) => change.type !== 'select')
    if (!allowDocumentMutation || durableChanges.length === 0) {
      return
    }

    commands.applyEdgeChanges(durableChanges)
  }, [allowDocumentMutation, commands])

  const handleProjectNameChange = (newName: string) => {
    if (allowDocumentMutation) {
      commands.setProjectName(newName)
    }
  }

  // Derive shots from nodes that have a shotId assigned (tagged to a shot)
  const scenesWithShots = useMemo(() => {
    return scenes.map(scene => {
      const sceneNodes = (allNodes as Node[]).filter(n => n.data.sceneId === scene.id)
      // Build a map of shot number -> node for tagged nodes. Falls back to
      // the legacy `selectedShotId` field that older reference-node code
      // wrote (before we standardised on `shotId`). Once a user re-touches
      // an old reference-node assignment, the new code clears the legacy
      // field so the two can't drift.
      const taggedNodes = sceneNodes.filter(n => n.data.shotId || n.data.selectedShotId)
      const shotMap = new Map<number, Node>()
      for (const n of taggedNodes) {
        const sid = (n.data.shotId || n.data.selectedShotId) as string
        const match = String(sid).match(/(\d+)$/)
        if (match) shotMap.set(parseInt(match[1]), n)
      }
      // Fill every slot from 1 to max with either a real shot or a placeholder
      const maxShot = shotMap.size > 0 ? Math.max(...shotMap.keys()) : 0
      const shots: Shot[] = []
      for (let i = 1; i <= maxShot; i++) {
        const n = shotMap.get(i)
        if (n) {
          shots.push({
            id: `shot-${n.id}`,
            nodeId: n.id,
            thumbnail: (n.type === 'videoGen'
              ? (n.data.videoThumbnail || n.data.thumbnail || n.data.assetUrl)
              : (n.data.outputUrl || n.data.thumbnail || n.data.assetUrl)) as string | undefined,
            // For video shots, outputUrl is the .mp4; for image shots it's
            // the generated image. Fall back to assetUrl/thumbnail for
            // upload/reference nodes that don't have an outputUrl.
            mediaUrl: (n.data.outputUrl || n.data.assetUrl || n.data.thumbnail) as string | undefined,
            label: n.data.label as string,
            hasVideo: n.type === 'videoGen',
            order: i,
          })
        } else {
          // Placeholder for gap
          shots.push({
            id: `placeholder-${scene.id}-${i}`,
            nodeId: '',
            thumbnail: undefined,
            label: undefined,
            hasVideo: false,
            order: i,
          })
        }
      }
      return { ...scene, shots }
    })
  }, [scenes, allNodes])

  const onConnect = useCallback((params: Connection) => {
    if (!allowDocumentMutation) {
      return
    }
    if ((params.source && lockedNodeIds.has(params.source)) || (params.target && lockedNodeIds.has(params.target))) {
      toast.error('This node is being edited by another collaborator')
      return
    }

    if (isValidConnection(params)) {
      commands.connect(params)
      // Force React Flow to re-measure the source/target handles. Without
      // this, edges connected to handles whose layout shifted after first
      // measurement (e.g. when the conditional reference-in handle first
      // mounts, or when zIndex/CSS recently changed) had stale cached
      // positions — the edge was added to state but its SVG path couldn't
      // resolve to real coordinates so nothing drew until a page refresh
      // re-measured from scratch.
      if (params.source) updateNodeInternals(params.source)
      if (params.target) updateNodeInternals(params.target)
    } else {
      const error = getConnectionError(params.sourceHandle ?? null, params.targetHandle ?? null)
      toast.error(error, {
        description: 'These node types are not compatible',
        duration: 3000,
      })
    }
  }, [allowDocumentMutation, commands, lockedNodeIds, updateNodeInternals])
  
  const [minimapOpen, setMinimapOpen] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowPos: { x: number; y: number } } | null>(null)
  const { fitView, screenToFlowPosition, setCenter, getNodes } = useReactFlow()
  const flowRef = useRef<HTMLDivElement>(null)

  const addNode = useCallback((type: string, flowPos?: { x: number; y: number }, initialData?: Record<string, any>) => {
    if (!allowDocumentMutation) return
    const pos = flowPos || screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    commands.createNode(makeNode(type, pos, undefined, activeSceneId, initialData))
  }, [allowDocumentMutation, screenToFlowPosition, commands, activeSceneId])

  // Scene handlers. Name = highest existing "Scene N" + 1 so deletes
  // don't reuse numbers (deleting Scene 3 then adding a new one gives
  // you Scene 6, not Scene 3 again — names monotonically increase
  // like shot numbers do, which avoids confusion when a node is
  // tagged to "Scene 3" and a different scene later wears that name).
  const handleAddScene = useCallback(() => {
    if (!allowDocumentMutation) return
    let maxNum = 0
    for (const s of scenes) {
      const m = s.name.match(/^Scene (\d+)$/)
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10))
    }
    commands.createScene(`Scene ${maxNum + 1}`)
    setSelectedNodeIds([])
  }, [allowDocumentMutation, commands, scenes])

  // Delete a scene: remove the scene itself, every node tagged with
  // that sceneId, and every edge between those nodes. The durable
  // realtime runtime persists and projects those deletions.
  //
  // If the active scene is being deleted, switch to the previous scene
  // in the list (or the first one if we're deleting the first scene)
  // before the removal so the user isn't left looking at an empty
  // canvas with no active sceneId.
  const handleDeleteScene = useCallback((sceneId: string) => {
    if (!allowDocumentMutation) return
    commands.deleteScene(sceneId)
    setSelectedNodeIds([])
  }, [allowDocumentMutation, commands])

  // Asset handlers
  const handleSelectAsset = useCallback((asset: Asset) => {}, [])

  const [isDragOver, setIsDragOver] = useState(false)

  // Handle drag over canvas - accept both internal assets and desktop files
  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasAsset = e.dataTransfer.types.includes('asset')
    const hasFiles = e.dataTransfer.types.includes('Files')
    const hasFolderAssets = e.dataTransfer.types.includes('folder-assets')
    if (!hasAsset && !hasFiles && !hasFolderAssets) return

    e.preventDefault()
    if (!allowDocumentMutation) {
      e.dataTransfer.dropEffect = 'none'
      setIsDragOver(false)
      return
    }

    e.dataTransfer.dropEffect = 'copy'
    if (hasFiles) setIsDragOver(true)
  }, [allowDocumentMutation])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only hide overlay if leaving the canvas entirely
    if (!e.currentTarget.contains(e.relatedTarget as Element)) {
      setIsDragOver(false)
    }
  }, [])

  // Handle drop - desktop files or internal assets
  const handleDrop = useCallback((e: React.DragEvent) => {
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') ||
      f.type.startsWith('video/') ||
      f.type.startsWith('audio/'),
    )
    const folderData = e.dataTransfer.getData('folder-assets')
    const assetData = e.dataTransfer.getData('asset')
    const recognizedDrop = files.length > 0 || Boolean(folderData) || Boolean(assetData)
    if (recognizedDrop) {
      e.preventDefault()
    }

    if (!allowDocumentMutation) return

    // Desktop file drop
    if (files.length > 0) {
      files.forEach((file, i) => {
        const pos = screenToFlowPosition({ x: e.clientX + i * 20, y: e.clientY + i * 20 })
        pasteImageFile(file, pos)
      })
      return
    }

    // Whole-folder drop from the sidebar's category panel: spawn one
    // reference node per asset, laid out as a small grid so they don't
    // stack on top of each other.
    if (folderData) {
      try {
        const payload = JSON.parse(folderData) as {
          folderName?: string
          assets: { id: string; r2_url: string; type?: string; prompt?: string }[]
        }
        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        const cols = Math.min(3, Math.max(1, payload.assets.length))
        const gap = 360
        const stamp = Date.now()
        const newNodes: Node[] = payload.assets.map((asset, i) => {
          const col = i % cols
          const row = Math.floor(i / cols)
          return {
            id: `ref-${stamp}-${i}`,
            type: 'reference',
            position: { x: flowPos.x + col * gap, y: flowPos.y + row * gap },
            data: {
              assetId: asset.id,
              thumbnail: asset.r2_url,
              label: payload.folderName || asset.prompt || 'Reference',
              mediaType: asset.type === 'video' ? 'video' : 'image',
              // Tag with the currently-active scene so the node shows on
              // the scene the user actually dropped it into, instead of
              // being filtered out everywhere (no sceneId = no scene
              // filter ever matches).
              sceneId: activeSceneId,
            },
          } as Node
        })
        commands.batch(({ createNode }) => {
          for (const node of newNodes) {
            createNode(node)
          }
        })
        // Auto-protect every asset we just dropped.
        for (const asset of payload.assets) {
          if (!asset.id) continue
          fetch(withBasePath(`/api/assets/${asset.id}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ used_in_canvas: true }),
          }).catch(() => {})
        }
        window.dispatchEvent(new CustomEvent('asset-status-changed'))
        return
      } catch (error) {
        console.error('Folder drop error:', error)
      }
    }

    // Internal asset drop from assets panel
    if (!assetData) return

    try {
      const asset = JSON.parse(assetData)
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })

      // Create node for this asset. Tag with the active scene so it
      // shows on the scene the user actually dropped it into.
      const newNode: Node = {
        id: `ref-${Date.now()}`,
        type: 'reference',
        position: flowPos,
        data: {
          assetId: asset.id,
          thumbnail: asset.r2_url,
          label: asset.prompt || 'Reference',
          mediaType: asset.type === 'video' ? 'video' : 'image',
          sceneId: activeSceneId,
        },
      }

      commands.createNode(newNode)

      // Mark asset as protected
      fetch(withBasePath(`/api/assets/${asset.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ used_in_canvas: true })
      }).then(() => {
        window.dispatchEvent(new CustomEvent('asset-status-changed'))
      }).catch(() => {})
    } catch (error) {
      console.error('Drop error:', error)
    }
  }, [allowDocumentMutation, screenToFlowPosition, commands, activeSceneId])

  // Shot click - center on node
  const handleShotClick = useCallback((sceneId: string, shotId: string) => {
    const shot = scenesWithShots.find(s => s.id === sceneId)?.shots.find(sh => sh.id === shotId)
    if (shot) {
      const node = allNodes.find(n => n.id === shot.nodeId)
      if (node) {
        setCenter(node.position.x + 200, node.position.y + 150, { zoom: 1, duration: 300 })
        setSelectedNodeIds([node.id])
      }
    }
  }, [scenesWithShots, allNodes, setCenter])

  const deleteSelected = useCallback(() => {
    if (!allowDocumentMutation) return
    const selectedIds = new Set(selectedNodeIds)
    if (selectedIds.size === 0) return

    const toDelete = allNodes.filter((node) => selectedIds.has(node.id))
    commands.batch(({ deleteNode }) => {
      for (const nodeId of selectedIds) {
        deleteNode(nodeId)
      }
    })
    setSelectedNodeIds([])

    for (const node of toDelete) {
      const assetId = node.data?.assetId as string | undefined
      const thumbnail = node.data?.thumbnail as string | undefined
      if (assetId) {
        fetch(withBasePath(`/api/assets/${assetId}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ used_in_canvas: false }),
        }).then(() => {
          window.dispatchEvent(new CustomEvent('asset-status-changed'))
        }).catch(() => {})
      } else if (thumbnail) {
        fetch(withBasePath(`/api/assets/by-url`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, url: thumbnail, used_in_canvas: false }),
        }).then(() => {
          window.dispatchEvent(new CustomEvent('asset-status-changed'))
        }).catch(() => {})
      }
    }
  }, [allowDocumentMutation, allNodes, commands, projectId, selectedNodeIds])

  const duplicateSelected = useCallback(() => {
    if (!allowDocumentMutation || selectedNodeIds.length === 0) return
    const duplicateIds = commands.duplicateNodes(selectedNodeIds)
    if (duplicateIds.length > 0) {
      setSelectedNodeIds(duplicateIds)
    }
  }, [allowDocumentMutation, commands, selectedNodeIds])

  // Paste image file as reference node - uploads to R2 for persistence
  const pasteImageFile = useCallback(async (file: File, pos?: { x: number; y: number }) => {
    if (!allowDocumentMutation) return
    const flowPos = pos || screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const nodeLabel = uploadedMediaLabel(file.name)
    const n = makeNode('reference', flowPos, nodeLabel, activeSceneId)
    
    // Create temp blob URL for immediate display
    const isVideoFile = file.type.startsWith('video/')
    const isAudioFile = file.type.startsWith('audio/')
    const tempUrl = URL.createObjectURL(file)
    const mediaType = isAudioFile ? 'audio' : isVideoFile ? 'video' : 'image'
    n.data = { ...n.data, thumbnail: tempUrl, isUploading: true, mediaType }
    commands.createNode(n)
    
    // Proxy every browser upload through the authenticated application route.
    // Browsers never contact R2 directly, so bucket CORS is irrelevant.
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('filename', file.name)
      const uploadRes = await fetch(withBasePath('/api/r2-upload'), {
        method: 'POST',
        body: formData,
      })
      if (!uploadRes.ok) {
        const detail = await uploadRes.text().catch(() => '')
        throw new Error(`upload failed: ${uploadRes.status} ${detail}`)
      }
      const { url } = await uploadRes.json() as { url: string }
      const proxyUrl = withBasePath(url)

      // Update node with proxy URL
      commands.patchNodeData(n.id, {
        thumbnail: proxyUrl,
        isUploading: false,
        uploadError: undefined,
      })

      // Record in assets with proxy URL and mark as protected (used in canvas)
      const assetRes = await fetch(withBasePath('/api/assets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: proxyUrl, type: mediaType, filename: file.name, projectId }),
      })
      const assetData = await assetRes.json()
      console.log('Asset recorded:', { assetData, status: assetRes.status })

      // Stash the asset's generation_history id on the node so the
      // node toolbar's "Add to folder" flow can pre-select it without
      // needing the modal to look it up by URL.
      if (assetData?.id) {
        commands.patchNodeData(n.id, {
          thumbnail: proxyUrl,
          isUploading: false,
          uploadError: undefined,
          assetId: assetData.id,
        })
      }

      // Asset is now recorded and protected (used_in_canvas = true)
      window.dispatchEvent(new CustomEvent('asset-status-changed'))

      // Revoke temp blob URL
      URL.revokeObjectURL(tempUrl)
    } catch (error) {
      console.error('Failed to upload media:', error)
      // Surface the failure — the previous silent catch left users
      // with a node that worked in the current session and then died
      // on reload because the blob URL was scoped to the session.
      const msg = error instanceof Error ? error.message : 'Upload failed'
      toast.error(`${mediaType} upload failed: ${msg.split(':')[0]}. Drop again to retry.`)
      // Keep temp URL if upload fails — user can still work with it
      // for the current session, but it will not persist.
      commands.patchNodeData(n.id, {
        isUploading: false,
        uploadError: true,
      })
    }
  }, [allowDocumentMutation, screenToFlowPosition, commands, activeSceneId])

  // Keyboard shortcuts
  useEffect(() => {
    function isEditingText(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null
      if (!el || !el.tagName) return false
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
      // contentEditable elements (the mention-textarea editor surface) have
      // tagName 'DIV', so the older INPUT/TEXTAREA check missed them — that's
      // why Backspace inside a prompt was bubbling up and deleting the node.
      if (el.isContentEditable) return true
      // Also bail if we're inside one (e.g. an inline chip inside the editor).
      if (el.closest?.('[contenteditable="true"]')) return true
      return false
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isEditingText(e.target)) return

      const ctrl = e.ctrlKey || e.metaKey

      // Undo/Redo
      if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (ctrl && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo() }
      if (ctrl && e.key === 'y') { e.preventDefault(); redo() }

      // Node type shortcuts
      if (ctrl && e.key === 'n') { e.preventDefault(); addNode('imageGen') }
      if (ctrl && e.key === 'k') { e.preventDefault(); addNode('videoGen') }
      if (ctrl && e.key === 't') { e.preventDefault(); addNode('prompt') }
      if (ctrl && e.key === 'r') { e.preventDefault(); addNode('reference') }

      // Edit shortcuts
      if (ctrl && e.key === 'c') {
        e.preventDefault()
        const selectedIds = new Set(selectedNodeIds)
        clipboardNodes = nodes
          .filter((node) => selectedIds.has(node.id))
          .map((node) => ({ ...node, data: { ...(node.data as Record<string, unknown>) } }))
      }
      if (ctrl && e.key === 'x') {
        e.preventDefault()
        const selectedIds = new Set(selectedNodeIds)
        clipboardNodes = nodes
          .filter((node) => selectedIds.has(node.id))
          .map((node) => ({ ...node, data: { ...(node.data as Record<string, unknown>) } }))
        deleteSelected()
      }
      // Ctrl+V for internal node clipboard — image paste is handled by onPaste
      if (allowDocumentMutation && ctrl && e.key === 'v' && clipboardNodes.length) {
        const copies = clipboardNodes.map((node) => ({
          ...node,
          id: makeId(),
          position: { x: node.position.x + 40, y: node.position.y + 40 },
          data: { ...(node.data as Record<string, unknown>) },
        }))
        commands.batch(({ createNode }) => {
          for (const copy of copies) {
            createNode(copy)
          }
        })
        setSelectedNodeIds(copies.map((node) => node.id))
      }
      if (ctrl && e.key === 'd') { e.preventDefault(); duplicateSelected() }

      // Delete — only the dedicated Delete key (NOT Backspace). Backspace
      // is too easy to hit by accident while editing prompts and was
      // wiping nodes; users can still use the toolbar's trash button or
      // the Delete key for explicit removal.
      if (e.key === 'Delete') deleteSelected()

      if (e.key === 'Escape') setContextMenu(null)
    }

    // Paste — image from system clipboard takes priority; falls back to node clipboard
    function onPaste(e: ClipboardEvent) {
      if (isEditingText(e.target)) return
      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItem = items.find(i => i.type.startsWith('image/'))
      if (imageItem) {
        e.preventDefault()
        const file = imageItem.getAsFile()
        if (file) pasteImageFile(file)
        return
      }
      // No image in clipboard — paste copied nodes if any
      if (allowDocumentMutation && clipboardNodes.length) {
        e.preventDefault()
        const copies = clipboardNodes.map((node) => ({
          ...node,
          id: makeId(),
          position: { x: node.position.x + 40, y: node.position.y + 40 },
          data: { ...(node.data as Record<string, unknown>) },
        }))
        commands.batch(({ createNode }) => {
          for (const copy of copies) {
            createNode(copy)
          }
        })
        setSelectedNodeIds(copies.map((node) => node.id))
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('paste', onPaste)
    }
  }, [addNode, allowDocumentMutation, commands, deleteSelected, duplicateSelected, nodes, pasteImageFile, redo, selectedNodeIds, undo])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setContextMenu({ x: e.clientX, y: e.clientY, flowPos })
  }, [screenToFlowPosition])

  // Smart-guide state. Populated on every drag tick with the flow
  // coordinates of any alignments between the dragged node and the
  // others; cleared when the drag finishes so guides only show during
  // active manipulation.
  const [dragGuides, setDragGuides] = useState<{ vertical: number[]; horizontal: number[] }>({
    vertical: [],
    horizontal: [],
  })

  const remotePresence = useMemo(
    () => projectRemotePresence(realtimePeers, { now: presenceNow }),
    [realtimePeers, presenceNow],
  )
  const lockedNodeMembershipKey = useMemo(() => {
    const locks = new Set<string>()
    for (const peer of remotePresence) {
      // Drag locks and focused editors are both exclusive node ownership
      // signals. Awareness gives peers immediate UI blocking; the server
      // lease still resolves races when a mutation is claimed.
      if (peer.lock?.nodeId) locks.add(peer.lock.nodeId)
      if (peer.editing?.nodeId) locks.add(peer.editing.nodeId)
    }
    return Array.from(locks).sort().join('\u0000')
  }, [remotePresence])
  const lockedNodeIds = useMemo(
    () => new Set(lockedNodeMembershipKey ? lockedNodeMembershipKey.split('\u0000') : []),
    [lockedNodeMembershipKey],
  )

  const onNodeDrag = useCallback((_event: any, node: Node) => {
    const others = (nodes as Node[]).filter(n => n.id !== node.id)
    const guides = computeAlignmentGuides(node, others)
    // Avoid re-rendering when nothing changed — set state by identity
    // comparison on the small flat arrays.
    setDragGuides(prev => {
      if (
        prev.vertical.length === guides.vertical.length &&
        prev.horizontal.length === guides.horizontal.length &&
        prev.vertical.every((v, i) => v === guides.vertical[i]) &&
        prev.horizontal.every((v, i) => v === guides.horizontal[i])
      ) return prev
      return guides
    })
  }, [nodes])

  const onNodeDragStart = useCallback((_event: any, node: Node) => {
    presenceControllerRef.current?.startDragLock(node.id)
  }, [])

  const onNodeDragStop = useCallback(() => {
    setDragGuides({ vertical: [], horizontal: [] })
    presenceControllerRef.current?.stopDragLock()
  }, [])

  const handlePresencePointerMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    presenceControllerRef.current?.publishCursor(
      screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    )
  }, [screenToFlowPosition])

  const handlePresencePointerLeave = useCallback(() => {
    presenceControllerRef.current?.publishCursor(null)
  }, [])

  // Memoize the scene-filtered nodes/edges so they don't get a fresh
  // array reference on every unrelated re-render (which would force
  // React Flow to re-diff the whole graph each time).
  const sceneNodes = useMemo(() => {
    const selectedIds = new Set(selectedNodeIds)
    return (nodes as Node[]).map((node) => {
      const nextNode = {
        ...node,
        selected: selectedIds.has(node.id),
      }
      if (!lockedNodeIds.has(node.id)) {
        return nextNode
      }

      return {
        ...nextNode,
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        // React Flow-level interaction and every nested toolbar/control are
        // blocked for a remote owner. Realtime document updates still render.
        style: { ...node.style, pointerEvents: 'none' },
        className: `${node.className ?? ''} ring-2 ring-amber-400/70 ring-offset-1 ring-offset-[#080A0C]`,
      }
    })
  }, [lockedNodeIds, nodes, selectedNodeIds])
  const selectedSceneNodeIds = useMemo(
    () => sceneNodes.filter(node => node.selected).map(node => node.id),
    [sceneNodes],
  )
  selectedSceneNodeIdsRef.current = selectedSceneNodeIds

  useEffect(() => {
    presenceControllerRef.current?.publishSelection(selectedSceneNodeIds)
  }, [selectedSceneNodeIds])

  useEffect(() => {
    const syncEditingPresence = (target: EventTarget | null) => {
      const snapshot = createLocalPresenceSnapshot(selectedSceneNodeIdsRef.current, target)
      presenceControllerRef.current?.publishEditing(snapshot.editing?.nodeId ?? null)
    }

    const handleFocusIn = (event: FocusEvent) => {
      syncEditingPresence(event.target)
    }
    const handleFocusOut = () => {
      window.setTimeout(() => {
        syncEditingPresence(document.activeElement)
      }, 0)
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  const sceneEdges = useMemo(() => {
    const sceneNodeIds = new Set(sceneNodes.map(n => n.id))
    return (edges as Edge[]).filter(e => sceneNodeIds.has(e.source) && sceneNodeIds.has(e.target))
  }, [edges, sceneNodes])
  const styledSceneEdges = useMemo(() => {
    const selectedNodeIds = new Set(sceneNodes.filter(n => n.selected).map(n => n.id))
    // Decide active-ness once, here, and pass the totals down. Previously every
    // cord called getEdges() and re-filtered all edges on each render to work
    // out the active count and whether idle animation was allowed — O(edges)
    // per edge = O(edges²) on every selection change. Computing it once and
    // handing each cord the numbers it needs removes that quadratic scan.
    const activeFlags = sceneEdges.map(
      e => selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target),
    )
    // A media cord whose source holds no image/video yet delivers nothing to the
    // target. Flag it so the cord renders as "not connected" instead of looking
    // identical to a live one — that ambiguity let references be silently
    // dropped. Prompt/text cords are exempt (they carry text, not media).
    const nodeById = new Map(sceneNodes.map(n => [n.id, n]))
    const emptyFlags = sceneEdges.map(e => {
      const isMediaCord =
        (e.sourceHandle && /image-out|video-out|audio-out/.test(e.sourceHandle)) ||
        (e.targetHandle && /image-in|video-in|reference-in|end-frame-in/.test(e.targetHandle))
      if (!isMediaCord) return false
      return nodeHasNoMedia(nodeById.get(e.source)?.data as Record<string, unknown>)
    })
    const activeCount = activeFlags.reduce((n, a) => (a ? n + 1 : n), 0)
    const edgeCount = sceneEdges.length
    return sceneEdges.map((edge, i) => ({
      ...edge,
      // Force the braided-cord edge component. Saved/loaded edges and edges
      // from onConnect don't carry a type, so without this they'd fall back
      // to React Flow's built-in line (which goes dashed when animated).
      type: 'scissors',
      // The cord runs its own hover/active animation; don't use React Flow's
      // `animated` (that's what produced the dashed look). Pass the active
      // state + animation preference + canvas-wide counts through data so the
      // cord can decide whether (and how) to animate without scanning edges.
      animated: false,
      data: {
        ...(edge.data || {}),
        active: activeFlags[i],
        empty: emptyFlags[i],
        animMode: connectorAnim,
        activeCount,
        edgeCount,
      },
      style: EDGE_STYLE,
    }))
  }, [sceneNodes, sceneEdges, connectorAnim])

  const handleFollowGuest = useCallback((peer: RemotePresencePeer) => {
    const target = resolveFollowTarget(peer, allNodes as Node[])
    if (!target.sceneId || !scenes.some((scene) => scene.id === target.sceneId)) {
      return
    }

    commands.switchScene(target.sceneId)
    if (target.point) {
      setCenter(target.point.x, target.point.y, { zoom: viewport.zoom, duration: 300 })
    }
  }, [allNodes, commands, scenes, setCenter, viewport.zoom])

  const handleRecenter = useCallback(() => {
    fitView({ duration: 300, padding: 0.2 })
  }, [fitView])

  return (
    <CanvasCollaborationProvider
      value={{
        ...realtime,
        commands,
        undo,
        redo,
      }}
    >
      <div className="flex flex-col h-screen bg-[#080A0C] overflow-hidden">
      <OnboardingTour surface="canvas" />
      {/* Auto-remove any persisted legacy note nodes on sync/hydration */}
      <LegacyNoteCleanup />
      {/* Scene Timeline */}
      <SceneTimeline
        scenes={scenesWithShots}
        activeSceneId={activeSceneId}
        onSceneChange={(sceneId) => {
          if (!allowDocumentMutation) return
          commands.switchScene(sceneId)
          setSelectedNodeIds([])
        }}
        onAddScene={handleAddScene}
        onDeleteScene={handleDeleteScene}
        onShotClick={handleShotClick}
        projectName={projectName}
      />

      {/* Top toolbar */}
      <CanvasToolbar
        projectName={projectName}
        onProjectNameChange={handleProjectNameChange}
        persistenceStatus={persistenceStatus}
        projectId={projectId}
        readOnly={readOnly}
        jobsPanelOpen={jobsPanelOpen}
        onToggleJobsPanel={() => setJobsPanelOpen(v => !v)}
        activeJobCount={activeJobCount}
        guests={remotePresence}
        onFollowGuest={handleFollowGuest}
      />

      {/* Right-side jobs panel — fixed position, doesn't capture canvas
          clicks so the user can pan/zoom/edit while it stays open. */}
      <JobsPanel open={jobsPanelOpen} onClose={() => setJobsPanelOpen(false)} />

      <div
        className="flex-1 relative"
        ref={flowRef}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
        onMouseMove={handlePresencePointerMove}
        onMouseLeave={handlePresencePointerLeave}
      >
        {isDragOver && (
          <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center border-2 border-dashed border-accent/60 bg-accent/5 rounded-lg">
            <div className="flex flex-col items-center gap-2 text-accent/80">
              <svg width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-8m0 0-3 3m3-3 3 3M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              <span className="text-sm font-mono">Drop to add to canvas</span>
            </div>
          </div>
        )}
        {/* Ghost sticker that follows cursor when sticker tool is active */}
        {activeTool === 'sticker' && (
          <StickerGhost containerRef={flowRef} />
        )}
        
        {/* Filter nodes and edges to show only active scene */}
        {(() => {
          // Note: these computations are wrapped in useMemo above this JSX
          // would be ideal, but the IIFE is fine if we limit allocations.
          // ReactFlow itself does heavy diffing internally; what matters
          // more is that the per-node React.memo blocks unrelated re-renders.
          return (
            <ReactFlow
              nodes={sceneNodes}
              edges={styledSceneEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodesDraggable={allowDocumentMutation}
              nodesConnectable={allowDocumentMutation}
              isValidConnection={isValidConnection}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={(_event, node) => {
                // Ownership begins before toolbars/settings can be opened.
                // Peers see it through awareness and their wrapper becomes
                // pointer-events:none; server lease remains the mutation gate.
                presenceControllerRef.current?.startDragLock(node.id)
                window.dispatchEvent(new Event('closeStickerPickers'))
              }}
              onPaneClick={(e) => {
                // Leaving a node releases its transient interaction lock.
                presenceControllerRef.current?.stopDragLock()
                // Always close any open sticker pickers
                window.dispatchEvent(new Event('closeStickerPickers'))

                // Place sticker or comment if tool is active
                if (allowDocumentMutation && (activeTool === 'sticker' || activeTool === 'comment')) {
                  const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
                  addNode(activeTool, flowPos)
                  setActiveTool('select')
                  return
                }
                // Default: deselect all
                setSelectedNodeIds([])
              }}
              onEdgeClick={(e, edge) => {
                // Cut tool: delete clicked edge
                if (allowDocumentMutation && activeTool === 'cut') {
                  commands.deleteEdge(edge.id)
                  return
                }
              }}
              nodeTypes={NODE_TYPES}
              onContextMenu={onContextMenu}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              panOnDrag={[1, 2]}
              panOnScroll
              panOnScrollMode={PanOnScrollMode.Free}
              zoomOnScroll={false}
              zoomOnPinch
              minZoom={0.1}
              maxZoom={4}
              style={{ 
                background: '#0D0F12',
                cursor: !allowDocumentMutation ? 'default' : activeTool === 'cut' ? 'crosshair' :
                       activeTool === 'sticker' ? 'none' :
                       activeTool === 'comment' ? 'copy' : 'default'
              }}
              proOptions={{ hideAttribution: true }}
              // Keep nodes mounted while they are off-screen. Generator polling,
              // upload completion, and mention-editor state live in the node
              // components; viewport culling unmounted them and lost those tasks.
              edgeTypes={EDGE_TYPES}
              defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1.5}
                color="#2a2e34"
              />

              {minimapOpen && (
                <MiniMap
                  style={{
                    background: 'rgba(13,15,18,0.95)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    width: 160,
                    height: 100,
                  }}
                  maskColor="rgba(8,10,12,0.7)"
                  nodeColor="rgba(107,143,168,0.5)"
                  position="bottom-right"
                  className="!bottom-14 !right-3"
                />
              )}
              <AlignmentGuides
                vertical={dragGuides.vertical}
                horizontal={dragGuides.horizontal}
              />
            </ReactFlow>
          )
        })()}

        <RealtimePresenceOverlay
          peers={remotePresence}
          nodes={sceneNodes}
          viewport={viewport}
        />

        {/* Unified left toolbar with assets */}
        <LeftToolbar 
          onAddNode={addNode}
          onSetTool={setActiveTool}
          activeTool={activeTool}
          onUndo={undo}
          onRedo={redo}
          canUndo={!readOnly}
          canRedo={!readOnly}
          assets={assets}
          onAssetsChange={setAssets}
          onSelectAsset={handleSelectAsset}
          projectId={projectId}
          showHistory={showHistory}
          onShowHistoryChange={setShowHistory}
        />

        {/* Minimap toggle when closed */}
        {!minimapOpen && (
          <button
            onClick={() => setMinimapOpen(true)}
            className="absolute bottom-14 right-3 z-20 glass flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
            title="Show minimap"
          >
            <MapTrifold size={14} weight="thin" />
          </button>
        )}

        {/* Close minimap button */}
        {minimapOpen && (
          <button
            onClick={() => setMinimapOpen(false)}
            className="absolute bottom-[118px] right-3 z-20 glass flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground transition-colors"
            title="Hide minimap"
          >
            <X size={10} weight="bold" />
          </button>
        )}

        <ViewportPersistor projectId={projectId} />
        <BottomBar page={scenes.findIndex(s => s.id === activeSceneId) + 1} onRecenter={handleRecenter} />
      </div>

      {/* Context menu backdrop + menu */}
      {contextMenu && (
        <>
          <div 
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation()
              setContextMenu(null)
            }}
          />
          <AddNodeMenu
            x={contextMenu.x}
            y={contextMenu.y}
 onSelect={(item) => {
  // Special handling for Assets - open history panel instead of adding node
  if (item.id === 'assets') {
    setShowHistory(true)
    setContextMenu(null)
    return
  }
  // Pass any menu-supplied preset (e.g. Upscaler → topaz-video-upscale) as
  // initial node data so the new node starts on the right model.
  const initialData = item.defaultModelId ? { modelId: item.defaultModelId } : undefined
  addNode(item.nodeType, contextMenu.flowPos, initialData)
  setContextMenu(null)
  }}
            onClose={() => setContextMenu(null)}
          />
        </>
      )}
      </div>
    </CanvasCollaborationProvider>
  )
}

export function CanvasWorkspace({ projectId }: { projectId: string }) {
  return (
    <ReactFlowProvider>
      <CanvasInner projectId={projectId} />
    </ReactFlowProvider>
  )
}
