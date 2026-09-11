'use client'

import { HocuspocusProvider, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import * as Y from 'yjs'

import { withBasePath } from '../lib/base-path'
import { needsDurableGenerationRecovery } from '../lib/durable-generation'
import {
  createReactFlowBinding,
  type RealtimeCanvasBinding,
  type RealtimeCanvasBindingSnapshot,
} from '../lib/realtime/react-flow-binding'
import type { ProjectRuntimeState } from '../realtime/project-runtime'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type AwarenessLike = {
  on?: (event: 'change' | 'update', listener: () => void) => void
  off?: (event: 'change' | 'update', listener: () => void) => void
  getStates: () => Map<number, Record<string, unknown>>
  getLocalState?: () => Record<string, unknown> | null
  setLocalState?: (state: Record<string, unknown> | null) => void
  setLocalStateField?: (field: string, value: unknown) => void
  destroy?: () => void
}

type ProviderLike = {
  awareness: AwarenessLike | null
  destroy: () => void
}

type RealtimeStatusMessage = {
  type: 'STATUS'
  projectId: string
  status: ProjectRuntimeState
}

type RealtimeAckMessage = {
  type: 'ACK'
  projectId: string
  status: 'PERSISTED'
  seq: number
}

export type RealtimeCanvasStatusMessage = RealtimeStatusMessage | RealtimeAckMessage

export type RealtimeAwarenessPeer = {
  clientId: number
  [key: string]: unknown
}

export type RealtimeCanvasRoomSnapshot = RealtimeCanvasBindingSnapshot & {
  peers: RealtimeAwarenessPeer[]
  persistenceStatus: ProjectRuntimeState
}

export type RealtimeCanvasCommands = Pick<
  RealtimeCanvasBinding,
  | 'applyNodeChanges'
  | 'applyEdgeChanges'
  | 'createNode'
  | 'patchNode'
  | 'patchNodeData'
  | 'updateNodeData'
  | 'replaceShot'
  | 'createNextShot'
  | 'deleteNode'
  | 'createEdge'
  | 'deleteEdge'
  | 'duplicateNodes'
  | 'connect'
  | 'createScene'
  | 'deleteScene'
  | 'switchScene'
  | 'setProjectName'
  | 'batch'
>

export type UseRealtimeCanvasResult = RealtimeCanvasRoomSnapshot & {
  awareness: AwarenessLike | null
  commands: RealtimeCanvasCommands
  undo: () => void
  redo: () => void
}

export type RealtimeCanvasRoomOptions = {
  websocketUrl?: string
  fetchFn?: FetchLike
  createProvider?: (configuration: HocuspocusProviderConfiguration) => ProviderLike
}

const ROOM_CACHE = new Map<string, RealtimeCanvasRoom>()
const EMPTY_COMMANDS: RealtimeCanvasCommands = {
  applyNodeChanges: () => {},
  applyEdgeChanges: () => {},
  createNode: () => {},
  patchNode: () => {},
  patchNodeData: () => {},
  updateNodeData: () => {},
  replaceShot: () => {},
  createNextShot: () => null,
  deleteNode: () => {},
  createEdge: () => {},
  deleteEdge: () => {},
  duplicateNodes: () => [],
  connect: () => null,
  createScene: () => 'scene-1',
  deleteScene: () => {},
  switchScene: () => {},
  setProjectName: () => {},
  batch: () => {},
}
const EMPTY_RESULT: UseRealtimeCanvasResult = {
  nodes: [],
  edges: [],
  allNodes: [],
  allEdges: [],
  scenes: [],
  activeSceneId: 'scene-1',
  projectName: 'Untitled Project',
  peers: [],
  persistenceStatus: 'SYNCED',
  awareness: null,
  commands: EMPTY_COMMANDS,
  undo: () => {},
  redo: () => {},
}

export function useRealtimeCanvas(
  projectId: string | undefined,
  options: RealtimeCanvasRoomOptions = {},
): UseRealtimeCanvasResult {
  const room = useMemo(() => {
    if (!projectId) {
      return null
    }

    return getOrCreateRealtimeCanvasRoom(projectId, options)
  }, [projectId, options.websocketUrl, options.fetchFn, options.createProvider])

  useEffect(() => {
    if (!projectId || !room) {
      return
    }

    room.retain()
    return () => {
      releaseRealtimeCanvasRoom(projectId)
    }
  }, [projectId, room])

  const snapshot = useSyncExternalStore(
    room ? room.subscribe : subscribeNoop,
    room ? room.getSnapshot : getEmptySnapshot,
    getEmptySnapshot,
  )

  if (!room) {
    return EMPTY_RESULT
  }

  return {
    ...snapshot,
    awareness: room.provider.awareness,
    commands: room.commands,
    undo: room.undo,
    redo: room.redo,
  }
}

export function getOrCreateRealtimeCanvasRoom(
  projectId: string,
  options: RealtimeCanvasRoomOptions = {},
): RealtimeCanvasRoom {
  const existing = ROOM_CACHE.get(projectId)
  if (existing) {
    return existing
  }

  const room = new RealtimeCanvasRoom(projectId, options)
  ROOM_CACHE.set(projectId, room)
  return room
}

export function releaseRealtimeCanvasRoom(projectId: string): void {
  const room = ROOM_CACHE.get(projectId)
  if (!room) {
    return
  }

  if (room.release() > 0) {
    return
  }

  room.destroy()
  ROOM_CACHE.delete(projectId)
}

export function parseRealtimeCanvasStatusMessage(
  payload: string,
  expectedProjectId?: string,
): RealtimeCanvasStatusMessage | null {
  try {
    const parsed = JSON.parse(payload) as RealtimeCanvasStatusMessage
    if (!parsed || typeof parsed !== 'object' || typeof parsed.projectId !== 'string') {
      return null
    }
    if (expectedProjectId && parsed.projectId !== expectedProjectId) {
      return null
    }

    if (
      parsed.type === 'STATUS' &&
      isProjectRuntimeState(parsed.status)
    ) {
      return parsed
    }

    if (
      parsed.type === 'ACK' &&
      parsed.status === 'PERSISTED' &&
      typeof parsed.seq === 'number'
    ) {
      return parsed
    }

    return null
  } catch {
    return null
  }
}

export function resolveRealtimeWebsocketUrl(locationLike = globalThis.location): string {
  const configuredUrl = process.env.NEXT_PUBLIC_REALTIME_URL?.trim()
  if (configuredUrl) {
    try {
      return new URL(configuredUrl).toString()
    } catch {
      // Fall back to the deployment's same-origin websocket proxy.
    }
  }

  if (!locationLike) {
    return withBasePath('/spite/ws')
  }

  const base = new URL(withBasePath('/spite/ws'), locationLike.href)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return base.toString()
}

export class RealtimeCanvasRoom {
  readonly doc: Y.Doc
  readonly binding: RealtimeCanvasBinding
  readonly provider: ProviderLike
  readonly commands: RealtimeCanvasCommands
  readonly undo: () => void
  readonly redo: () => void

  private refCount = 0
  private snapshot: RealtimeCanvasRoomSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly fetchFn: FetchLike
  private readonly recoveringGenerationKeys = new Set<string>()
  private hasCompletedInitialSync = false

  constructor(
    readonly projectId: string,
    options: RealtimeCanvasRoomOptions,
  ) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.doc = new Y.Doc()
    this.binding = createReactFlowBinding(this.doc)
    this.snapshot = {
      ...this.binding.getSnapshot(),
      peers: [],
      persistenceStatus: 'SYNCED',
    }

    this.binding.subscribe(() => {
      this.snapshot = {
        ...this.snapshot,
        ...this.binding.getSnapshot(),
      }
      if (this.hasCompletedInitialSync) {
        void this.recoverDurableGenerations()
      }
      this.emit()
    })

    this.provider = (options.createProvider ?? createDefaultProvider)({
      url: options.websocketUrl ?? resolveRealtimeWebsocketUrl(),
      name: `project:${projectId}`,
      document: this.doc,
      token: () => this.getToken(),
      forceSyncInterval: false,
      preserveTrailingSlash: false,
      onStateless: ({ payload }) => {
        this.handleStateless(payload)
      },
      onSynced: ({ state }) => {
        if (state) {
          this.hasCompletedInitialSync = true
          void this.recoverDurableGenerations()
        }
      },
    } as HocuspocusProviderConfiguration)

    const awareness = this.provider.awareness
    awareness?.on?.('change', this.handleAwarenessChange)
    awareness?.on?.('update', this.handleAwarenessChange)

    this.commands = {
      applyNodeChanges: this.binding.applyNodeChanges,
      applyEdgeChanges: this.binding.applyEdgeChanges,
      createNode: this.binding.createNode,
      patchNode: this.binding.patchNode,
      patchNodeData: this.binding.patchNodeData,
      updateNodeData: this.binding.updateNodeData,
      replaceShot: this.binding.replaceShot,
      createNextShot: this.binding.createNextShot,
      deleteNode: this.binding.deleteNode,
      createEdge: this.binding.createEdge,
      deleteEdge: this.binding.deleteEdge,
      duplicateNodes: this.binding.duplicateNodes,
      connect: this.binding.connect,
      createScene: this.binding.createScene,
      deleteScene: this.binding.deleteScene,
      switchScene: this.binding.switchScene,
      setProjectName: this.binding.setProjectName,
      batch: this.binding.batch,
    }
    this.undo = this.binding.undo
    this.redo = this.binding.redo
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): RealtimeCanvasRoomSnapshot => this.snapshot

  retain(): () => void {
    this.refCount += 1
    return () => {
      releaseRealtimeCanvasRoom(this.projectId)
    }
  }

  release(): number {
    this.refCount = Math.max(0, this.refCount - 1)
    return this.refCount
  }

  async recoverDurableGenerations(): Promise<void> {
    const recoveries = this.snapshot.allNodes.flatMap((node) => {
      const data = node.data as Record<string, unknown>
      const generationId = data.generationId
      if (!needsDurableGenerationRecovery(data) || typeof generationId !== 'string') {
        return []
      }

      const key = `${this.projectId}:${node.id}:${generationId}`
      if (this.recoveringGenerationKeys.has(key)) {
        return []
      }

      this.recoveringGenerationKeys.add(key)
      const query = new URLSearchParams({
        projectId: this.projectId,
        nodeId: node.id,
        generationId,
      })
      return [this.requestDurableGenerationRecovery(key, query)]
    })

    await Promise.all(recoveries)
  }

  private async requestDurableGenerationRecovery(key: string, query: URLSearchParams): Promise<void> {
    try {
      const response = await this.fetchFn(withBasePath(`/api/generate/status?${query}`), {
        credentials: 'include',
      })
      if (!response.ok) {
        throw new Error(`Generation status request failed with HTTP ${response.status}`)
      }

      const payload = await response.json() as { generationStatus?: unknown }
      if (payload.generationStatus !== 'queued' && payload.generationStatus !== 'processing') {
        this.recoveringGenerationKeys.delete(key)
      }
    } catch {
      this.recoveringGenerationKeys.delete(key)
    }
  }

  async getToken(): Promise<string> {
    const response = await this.fetchFn(withBasePath('/api/auth/realtime-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: this.projectId }),
    })

    if (!response.ok) {
      throw new Error(`Realtime token request failed with HTTP ${response.status}`)
    }

    const payload = (await response.json()) as { token?: unknown }
    if (!payload || typeof payload.token !== 'string' || payload.token.length === 0) {
      throw new Error('Realtime token response did not include a token')
    }

    return payload.token
  }

  destroy(): void {
    this.provider.awareness?.off?.('change', this.handleAwarenessChange)
    this.provider.awareness?.off?.('update', this.handleAwarenessChange)
    this.binding.destroy()
    this.provider.destroy()
    this.recoveringGenerationKeys.clear()
    this.listeners.clear()
  }

  private readonly handleAwarenessChange = () => {
    this.snapshot = {
      ...this.snapshot,
      peers: readAwarenessPeers(this.provider.awareness, this.doc.clientID),
    }
    this.emit()
  }

  private handleStateless(payload: string): void {
    const message = parseRealtimeCanvasStatusMessage(payload, this.projectId)
    if (!message) {
      return
    }

    this.snapshot = {
      ...this.snapshot,
      persistenceStatus: message.status,
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

function createDefaultProvider(configuration: HocuspocusProviderConfiguration): ProviderLike {
  return new HocuspocusProvider(configuration)
}

function readAwarenessPeers(
  awareness: AwarenessLike | null,
  localClientId: number,
): RealtimeAwarenessPeer[] {
  if (!awareness) {
    return []
  }

  return Array.from(awareness.getStates().entries())
    .filter(([clientId]) => clientId !== localClientId)
    .map(([clientId, state]) => ({
      clientId,
      ...(state ?? {}),
    }))
}

function isProjectRuntimeState(value: unknown): value is ProjectRuntimeState {
  return value === 'SYNCED' || value === 'PERSISTING' || value === 'PERSISTED' || value === 'DEGRADED' || value === 'READ_ONLY'
}

function subscribeNoop(): () => void {
  return () => {}
}

function getEmptySnapshot(): RealtimeCanvasRoomSnapshot {
  return EMPTY_RESULT
}
