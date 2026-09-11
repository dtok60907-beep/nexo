import { fileURLToPath } from 'node:url'

import { Server, type onAuthenticatePayload, type onRequestPayload } from '@hocuspocus/server'
import * as Y from 'yjs'

import { parseProjectDocumentName } from '../lib/realtime/document'
import {
  applyInternalDocumentAction,
  buildInternalDocumentExport,
} from '../lib/realtime/internal-client'
import { verifyRealtimeToken } from './auth'
import { createDatabaseAdapter, type DatabaseAdapter } from './db'
import {
  createCanvasAuthorizationActionDigest,
  verifyCanvasAuthorization,
  type CanvasAuthorizationPayload,
} from './internal-auth'
import {
  ProjectRuntime,
  type ProjectRuntimeClock,
  type ProjectRuntimeState,
} from './project-runtime'
import { YjsRepository } from './yjs-repository'

type RealtimeEnvironment = {
  REALTIME_TOKEN_SECRET?: string
  CANVAS_AUTH_SECRET?: string
  PORT?: string
  HOST?: string
}

type LoadedProjectDocument = Awaited<ReturnType<YjsRepository['loadOrImport']>>

type RealtimeRepository = Pick<
  YjsRepository,
  'ownsProject' | 'loadOrImport' | 'appendUpdate' | 'compact' | 'close'
>

type RealtimeRuntime = Pick<ProjectRuntime, 'enqueue'> &
  Partial<Pick<ProjectRuntime, 'canAcceptMutation' | 'flush' | 'compact' | 'shutdown' | 'scheduleProjection'>>

type RuntimeFactory = (options: {
  projectId: string
  doc: Y.Doc
  repository: RealtimeRepository
  loaded: LoadedProjectDocument
  onStateChange?: (state: ProjectRuntimeState) => void
}) => RealtimeRuntime

type ConnectionContext = {
  projectId: string
  userId: string
}

type RealtimeConnection = {
  socketId: string
  readOnly: boolean
  sendStateless(payload: string): void
}

type RealtimeDocument = Y.Doc & {
  awareness: {
    states: Map<number, Record<string, unknown>>
    meta: Map<number, { clock: number; lastUpdated: number }>
    getStates(): Map<number, Record<string, unknown>>
    emit(event: 'change' | 'update', payload: unknown): void
  }
  getConnections(): RealtimeConnection[]
  broadcastStateless(payload: string, filter?: (connection: RealtimeConnection) => boolean): void
}

type RoomState = {
  projectId: string
  doc: RealtimeDocument
  runtime: RealtimeRuntime
  status: ProjectRuntimeState
  guestNumbers: Map<string, number>
  participantRefCounts: Map<string, number>
  socketParticipants: Map<string, Set<string>>
  participantClientIds: Map<string, Set<number>>
  lockTimers: Map<string, ProjectRuntimeTimer>
}

type RoomLifecycleClock = ProjectRuntimeClock

type ProjectRuntimeTimer = ReturnType<typeof setTimeout> | number

export type RealtimeServerEvent = {
  type:
    | 'http:authorize'
    | 'http:authorize:granted'
    | 'http:authorize:denied'
    | 'ws:authorized'
    | 'ws:load-document'
    | 'ws:before-sync'
    | 'ws:change'
    | 'ws:enqueue'
    | 'ws:status'
    | 'ws:ack'
    | 'ws:disconnect'
    | 'server:shutdown:start'
    | 'server:shutdown:complete'
  projectId?: string
  userId?: string
  connectionId?: string
  socketId?: string
  status?: ProjectRuntimeState
  seq?: number
}

export type RealtimeServerOptions = {
  address?: string
  port?: number
  quiet?: boolean
  env?: RealtimeEnvironment
  repository?: RealtimeRepository
  database?: DatabaseAdapter
  verifyToken?: typeof verifyRealtimeToken
  verifyCanvasRequest?: typeof verifyCanvasAuthorization
  createRuntime?: RuntimeFactory
  onEvent?: (event: RealtimeServerEvent) => void
  clock?: RoomLifecycleClock
  awarenessLockTtlMs?: number
}

export type RealtimeServerHandle = {
  listen(port?: number): Promise<void>
  destroy(): Promise<void>
  readonly httpUrl: string
  readonly wsUrl: string
  getConnectionCount(): number
}

const DEFAULT_ADDRESS = '127.0.0.1'
const NONCE_TTL_SECONDS = 60
const DEFAULT_AWARENESS_LOCK_TTL_MS = 15_000
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const SIGNALS = ['SIGINT', 'SIGTERM'] as const

export function createRealtimeServer(options: RealtimeServerOptions = {}): RealtimeServerHandle {
  const env: RealtimeEnvironment = {
    ...process.env,
    ...options.env,
  }
  const database = options.database ?? createDatabaseAdapter()
  const repository = options.repository ?? new YjsRepository({ database })
  const ownsRepository = !options.repository
  const ownsDatabase = !options.database && !!options.repository
  const verifyToken = options.verifyToken ?? verifyRealtimeToken
  const verifyCanvasRequest = options.verifyCanvasRequest ?? verifyCanvasAuthorization
  const emit = options.onEvent ?? (() => {})
  const clock = options.clock ?? createRoomLifecycleClock()
  const awarenessLockTtlMs = options.awarenessLockTtlMs ?? DEFAULT_AWARENESS_LOCK_TTL_MS
  const connectionContexts = new Map<string, ConnectionContext>()
  const rooms = new Map<string, RoomState>()

  let shuttingDown = false
  let destroyPromise: Promise<void> | null = null
  let signalHandlersRegistered = false

  const signalHandler = () => {
    void handle.destroy()
  }

  const hocuspocusServer = new Server<ConnectionContext>({
    address: options.address ?? env.HOST ?? DEFAULT_ADDRESS,
    port: options.port,
    quiet: options.quiet ?? true,
    stopOnSignals: false,
    onRequest: async (payload) => {
      if (await handleHttpRequest(payload, {
        env,
        database,
        repository,
        verifyCanvasRequest,
        emit,
        rooms,
        createRuntime: options.createRuntime ?? createProjectRuntime,
        isShuttingDown: () => shuttingDown,
      })) {
        throw undefined
      }
    },
    onAuthenticate: async (payload) => {
      const context = await authenticateConnection(payload, {
        env,
        repository,
        verifyToken,
        emit,
        rooms,
        isShuttingDown: () => shuttingDown,
      })
      connectionContexts.set(payload.socketId, context)
      emit({
        type: 'ws:authorized',
        projectId: context.projectId,
        userId: context.userId,
        connectionId: payload.socketId,
        socketId: payload.socketId,
      })
      return context
    },
    onLoadDocument: async (payload) => {
      const context = requireConnectionContext(payload.socketId, connectionContexts, payload.documentName)
      emit({
        type: 'ws:load-document',
        projectId: context.projectId,
        userId: context.userId,
        connectionId: payload.socketId,
        socketId: payload.socketId,
      })

      const existingRoom = rooms.get(context.projectId)
      if (existingRoom) {
        return existingRoom.doc
      }

      const loaded = await repository.loadOrImport(context.projectId)
      const document = payload.document as RealtimeDocument
      Y.applyUpdate(document, Y.encodeStateAsUpdate(loaded.doc))

      let room!: RoomState
      const runtime = (options.createRuntime ?? createProjectRuntime)({
        projectId: context.projectId,
        doc: document,
        repository,
        loaded,
        onStateChange: (state) => {
          handleRuntimeStateChange(room, state, { emit, isShuttingDown: () => shuttingDown })
        },
      })

      room = {
        projectId: context.projectId,
        doc: document,
        runtime,
        status: runtimeCanAcceptMutation(runtime) ? 'SYNCED' : 'READ_ONLY',
        guestNumbers: new Map(),
        participantRefCounts: new Map(),
        socketParticipants: new Map(),
        participantClientIds: new Map(),
        lockTimers: new Map(),
      }

      rooms.set(context.projectId, room)
      applyRoomReadOnly(room, shuttingDown || !runtimeCanAcceptMutation(runtime))
      if (loaded.projectedSeq < loaded.durableSeq && typeof runtime.scheduleProjection === 'function') {
        runtime.scheduleProjection(loaded.durableSeq)
      }

      return room.doc
    },
    beforeHandleAwareness: async (payload) => {
      const context = requireDocumentContext(payload.documentName, payload.context)
      const room = rooms.get(context.projectId)
      if (!room) {
        throw new Error(`Missing realtime room for ${context.projectId}`)
      }

      sanitizeAwarenessStates(payload, room, {
        clock,
        awarenessLockTtlMs,
        userId: context.userId,
      })
    },
    connected: async (payload) => {
      const context = requireDocumentContext(payload.documentName, payload.context)
      const room = rooms.get(context.projectId)
      if (!room) {
        return
      }

      payload.connection.readOnly = shuttingDown || !runtimeCanAcceptMutation(room.runtime)
      sendStatusToConnection(payload.connection as RealtimeConnection, room.projectId, room.status, emit)
    },
    beforeSync: async (payload) => {
      const context = requireDocumentContext(payload.documentName, payload.context)
      const room = rooms.get(context.projectId)
      if (room) {
        payload.connection.readOnly = shuttingDown || !runtimeCanAcceptMutation(room.runtime)
      }

      emit({
        type: 'ws:before-sync',
        projectId: context.projectId,
        userId: context.userId,
        connectionId: payload.connection.socketId,
        socketId: payload.connection.socketId,
      })
    },
    onChange: async (payload) => {
      const context = requireDocumentContext(payload.documentName, payload.context)
      const room = rooms.get(context.projectId)
      if (!room) {
        throw new Error(`Missing realtime room for ${context.projectId}`)
      }

      if (isInternalDocumentOrigin(payload.transactionOrigin)) {
        return
      }

      emit({
        type: 'ws:change',
        projectId: context.projectId,
        userId: context.userId,
        connectionId: payload.socketId,
        socketId: payload.socketId,
      })

      void persistRoomChange({
        payload,
        room,
        context,
        emit,
      })
    },
    onDisconnect: async (payload) => {
      const context = connectionContexts.get(payload.socketId)
      connectionContexts.delete(payload.socketId)
      if (context) {
        releaseSocketParticipants(rooms.get(context.projectId), payload.socketId, clock)
      }
      emit({
        type: 'ws:disconnect',
        projectId: context?.projectId,
        userId: context?.userId,
        connectionId: payload.socketId,
        socketId: payload.socketId,
      })
    },
    afterUnloadDocument: async ({ documentName }) => {
      try {
        const projectId = parseProjectDocumentName(documentName)
        const room = rooms.get(projectId)
        if (room) {
          clearRoomTimers(room, clock)
        }
        rooms.delete(projectId)
      } catch {
        // Ignore malformed names after Hocuspocus teardown.
      }
    },
  })

  const handle: RealtimeServerHandle = {
    async listen(port?: number): Promise<void> {
      await hocuspocusServer.listen(port ?? options.port ?? readPort(env.PORT))
      registerSignalHandlers()
    },

    async destroy(): Promise<void> {
      if (destroyPromise) {
        return destroyPromise
      }

      destroyPromise = shutdownServer()
      return destroyPromise
    },

    get httpUrl(): string {
      return `http://127.0.0.1:${hocuspocusServer.address.port}`
    },

    get wsUrl(): string {
      return `ws://127.0.0.1:${hocuspocusServer.address.port}`
    },

    getConnectionCount(): number {
      return connectionContexts.size
    },
  }

  return handle

  function registerSignalHandlers(): void {
    if (signalHandlersRegistered) {
      return
    }

    for (const signal of SIGNALS) {
      process.on(signal, signalHandler)
    }
    signalHandlersRegistered = true
  }

  function unregisterSignalHandlers(): void {
    if (!signalHandlersRegistered) {
      return
    }

    for (const signal of SIGNALS) {
      process.off(signal, signalHandler)
    }
    signalHandlersRegistered = false
  }

  async function shutdownServer(): Promise<void> {
    shuttingDown = true
    emit({ type: 'server:shutdown:start' })

    try {
      const shutdownRooms = [...rooms.values()]
      for (const room of shutdownRooms) {
        applyRoomReadOnly(room, true)
        broadcastRoomStatus(room, 'READ_ONLY', emit)
      }

      await Promise.all(shutdownRooms.map((room) => shutdownRoom(room)))
      await hocuspocusServer.destroy()

      if (ownsRepository) {
        await repository.close()
      } else if (ownsDatabase) {
        await database.close()
      }
    } finally {
      unregisterSignalHandlers()
      emit({ type: 'server:shutdown:complete' })
    }
  }

  async function shutdownRoom(room: RoomState): Promise<void> {
    clearRoomTimers(room, clock)

    if (typeof room.runtime.shutdown === 'function') {
      await room.runtime.shutdown()
      return
    }

    if (typeof room.runtime.flush === 'function') {
      await room.runtime.flush()
    }

    if (typeof room.runtime.compact === 'function') {
      await room.runtime.compact()
    }
  }
}

function createProjectRuntime({
  projectId,
  doc,
  repository,
  onStateChange,
}: Parameters<RuntimeFactory>[0]): RealtimeRuntime {
  return new ProjectRuntime({
    projectId,
    doc,
    repository,
    onStateChange,
  })
}

async function handleHttpRequest(
  payload: onRequestPayload,
  {
    env,
    database,
    repository,
    verifyCanvasRequest,
    emit,
    rooms,
    createRuntime,
    isShuttingDown,
  }: {
    env: RealtimeEnvironment
    database: DatabaseAdapter
    repository: RealtimeRepository
    verifyCanvasRequest: typeof verifyCanvasAuthorization
    emit: (event: RealtimeServerEvent) => void
    rooms: Map<string, RoomState>
    createRuntime: RuntimeFactory
    isShuttingDown: () => boolean
  },
): Promise<boolean> {
  const requestUrl = new URL(payload.request.url ?? '/', 'http://127.0.0.1')

  if (payload.request.method === 'GET' && requestUrl.pathname === '/healthz') {
    writeJson(payload.response, 200, { ok: true })
    return true
  }

  if (requestUrl.pathname !== '/internal/authorize' && requestUrl.pathname !== '/internal/document') {
    return false
  }

  if (payload.request.method !== 'POST') {
    writeJson(payload.response, 405, { authorized: false })
    return true
  }

  const body = await readJsonBody(payload.request)
  if (!body) {
    writeJson(payload.response, 400, { authorized: false })
    return true
  }

  const authorizationPayload = {
    userId: body.userId,
    projectId: body.projectId,
    timestamp: body.timestamp,
    nonce: body.nonce,
    ...(requestUrl.pathname === '/internal/document'
      ? { actionDigest: createCanvasAuthorizationActionDigest(extractSignedActionPayload(body)) }
      : {}),
  }

  emit({
    type: 'http:authorize',
    projectId: stringOrUndefined(body.projectId),
    userId: stringOrUndefined(body.userId),
  })

  if (
    !verifyCanvasRequest(
      authorizationPayload as CanvasAuthorizationPayload,
      typeof body.signature === 'string' ? body.signature : '',
      env.CANVAS_AUTH_SECRET ?? '',
    )
  ) {
    writeJson(payload.response, 403, { authorized: false })
    emit({ type: 'http:authorize:denied' })
    return true
  }

  const allowed = await authorizeCanvasRequest({
    database,
    payload: authorizationPayload as CanvasAuthorizationPayload,
  })

  if (!allowed) {
    writeJson(payload.response, 403, { authorized: false })
    emit({
      type: 'http:authorize:denied',
      projectId: stringOrUndefined(authorizationPayload.projectId),
      userId: stringOrUndefined(authorizationPayload.userId),
    })
    return true
  }

  if (requestUrl.pathname === '/internal/authorize') {
    writeJson(payload.response, 200, { authorized: true })
    emit({
      type: 'http:authorize:granted',
      projectId: stringOrUndefined(authorizationPayload.projectId),
      userId: stringOrUndefined(authorizationPayload.userId),
    })
    return true
  }

  try {
    const projectId = String(authorizationPayload.projectId)
    const userId = String(authorizationPayload.userId)
    const action = typeof body.action === 'string' ? body.action : ''
    const result = await handleInternalDocumentRequest({
      projectId,
      userId,
      action,
      body,
      repository,
      rooms,
      createRuntime,
      emit,
      isShuttingDown,
    })

    writeJson(payload.response, 200, result)
    emit({
      type: 'http:authorize:granted',
      projectId,
      userId,
    })
  } catch (error) {
    writeJson(payload.response, resolveInternalDocumentErrorStatus(error), {
      error: error instanceof Error ? error.message : 'Internal document request failed',
    })
  }

  return true
}

async function authenticateConnection(
  payload: onAuthenticatePayload<ConnectionContext>,
  {
    env,
    repository,
    verifyToken,
    emit: _emit,
    rooms,
    isShuttingDown,
  }: {
    env: RealtimeEnvironment
    repository: RealtimeRepository
    verifyToken: typeof verifyRealtimeToken
    emit: (event: RealtimeServerEvent) => void
    rooms: Map<string, RoomState>
    isShuttingDown: () => boolean
  },
): Promise<ConnectionContext> {
  const projectId = parseProjectDocumentName(payload.documentName)

  if (isShuttingDown()) {
    throw forbidden('server shutting down')
  }

  const claims = await verifyToken(payload.token, projectId, env.REALTIME_TOKEN_SECRET ?? '')

  if (!claims) {
    throw forbidden('invalid token')
  }

  const ownsProject = await repository.ownsProject(projectId, claims.userId)
  if (!ownsProject) {
    throw forbidden('project access denied')
  }

  const room = rooms.get(projectId)
  payload.connectionConfig.readOnly = !!room && !runtimeCanAcceptMutation(room.runtime)

  return {
    projectId,
    userId: claims.userId,
  }
}

async function authorizeCanvasRequest({
  database,
  payload,
}: {
  database: DatabaseAdapter
  payload: CanvasAuthorizationPayload
}): Promise<boolean> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query(
        `
          INSERT INTO canvas_auth_nonces (nonce, created_at, expires_at)
          VALUES ($1, NOW(), to_timestamp($2) + INTERVAL '1 second' * $3)
        `,
        [payload.nonce, payload.timestamp, NONCE_TTL_SECONDS],
      )

      const result = await tx.query(
        `SELECT 1 FROM projects WHERE id = $1 AND userid = $2 LIMIT 1`,
        [payload.projectId, payload.userId],
      )

      return result.rows.length > 0
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false
    }
    throw error
  }
}

async function handleInternalDocumentRequest({
  projectId,
  userId,
  action,
  body,
  repository,
  rooms,
  createRuntime,
  emit,
  isShuttingDown,
}: {
  projectId: string
  userId: string
  action: string
  body: Record<string, unknown>
  repository: RealtimeRepository
  rooms: Map<string, RoomState>
  createRuntime: RuntimeFactory
  emit: (event: RealtimeServerEvent) => void
  isShuttingDown: () => boolean
}): Promise<Record<string, unknown>> {
  if (isShuttingDown()) {
    throw new Error('server shutting down')
  }

  const room = rooms.get(projectId)
  if (room) {
    if (action === 'export-document') {
      if (typeof room.runtime.flush === 'function') {
        await room.runtime.flush()
      }
      const loaded = await repository.loadOrImport(projectId)
      return {
        ...buildInternalDocumentExport(room.doc),
        durableSeq: loaded.durableSeq,
        projectedSeq: loaded.projectedSeq,
      }
    }

    const result = await applyInternalActionWithRuntime({
      doc: room.doc,
      runtime: room.runtime,
      projectId,
      userId,
      action,
      body,
      emit,
    })
    return { ok: true, ...result }
  }

  const loaded = await repository.loadOrImport(projectId)
  if (action === 'export-document') {
    return {
      ...buildInternalDocumentExport(loaded.doc),
      durableSeq: loaded.durableSeq,
      projectedSeq: loaded.projectedSeq,
    }
  }

  const runtime = createRuntime({
    projectId,
    doc: loaded.doc,
    repository,
    loaded,
  })
  const result = await applyInternalActionWithRuntime({
    doc: loaded.doc,
    runtime,
    projectId,
    userId,
    action,
    body,
    emit,
  })
  return { ok: true, ...result }
}

async function applyInternalActionWithRuntime({
  doc,
  runtime,
  projectId,
  userId,
  action,
  body,
  emit,
}: {
  doc: Y.Doc
  runtime: RealtimeRuntime
  projectId: string
  userId: string
  action: string
  body: Record<string, unknown>
  emit: (event: RealtimeServerEvent) => void
}): Promise<{ durableSeq: number; applied: boolean }> {
  if (action === 'patch-node-data' && !nodeDataMatches(doc, body)) {
    return { durableSeq: 0, applied: false }
  }

  const mergedUpdate = buildInternalDocumentUpdate(doc, action, body, createInternalDocumentOrigin(projectId, userId))
  if (!mergedUpdate) {
    return { durableSeq: 0, applied: false }
  }

  emit({
    type: 'ws:enqueue',
    projectId,
    userId,
  })
  const durableSeq = await runtime.enqueue(mergedUpdate)
  if (typeof runtime.flush === 'function') {
    await runtime.flush()
  }
  Y.applyUpdate(doc, mergedUpdate, createInternalDocumentOrigin(projectId, userId))
  return { durableSeq, applied: true }
}

function nodeDataMatches(doc: Y.Doc, body: Record<string, unknown>): boolean {
  if (typeof body.nodeId !== 'string') return false
  const expected = body.expected
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return true
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(body.nodeId)
  if (!(node instanceof Y.Map)) return false
  const data = node.get('data')
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return Object.entries(expected).every(([key, value]) => {
    const current = (data as Record<string, unknown>)[key]
    return current === value || (value === null && current === undefined)
  })
}

function buildInternalDocumentUpdate(
  sourceDoc: Y.Doc,
  action: string,
  body: Record<string, unknown>,
  origin: unknown,
): Uint8Array | null {
  const workingDoc = new Y.Doc()
  Y.applyUpdate(workingDoc, Y.encodeStateAsUpdate(sourceDoc))

  const updates: Uint8Array[] = []
  const updateListener = (update: Uint8Array) => {
    updates.push(new Uint8Array(update))
  }

  workingDoc.on('update', updateListener)
  try {
    applyInternalDocumentAction(workingDoc, action, body, origin)
  } finally {
    workingDoc.off('update', updateListener)
  }

  if (updates.length === 0) {
    return null
  }

  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates)
}

function createInternalDocumentOrigin(projectId: string, userId: string): {
  source: 'local'
  reason: 'internal-document'
  context: ConnectionContext
} {
  return {
    source: 'local',
    reason: 'internal-document',
    context: {
      projectId,
      userId,
    },
  }
}

function isInternalDocumentOrigin(origin: unknown): boolean {
  return !!origin
    && typeof origin === 'object'
    && (origin as { source?: unknown }).source === 'local'
    && (origin as { reason?: unknown }).reason === 'internal-document'
}

function isReadOnlyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('read-only')
}

function isServiceUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('shutting down')
}

function isValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message === 'projection is required'
    || error.message.startsWith('Unsupported internal document action:')
}

function resolveInternalDocumentErrorStatus(error: unknown): number {
  if (isValidationError(error)) {
    return 400
  }

  if (isReadOnlyError(error)) {
    return 409
  }

  if (isServiceUnavailableError(error)) {
    return 503
  }

  return 500
}

async function persistRoomChange({
  payload,
  room,
  context,
  emit,
}: {
  payload: { update: Uint8Array; connection?: RealtimeConnection; socketId: string }
  room: RoomState
  context: ConnectionContext
  emit: (event: RealtimeServerEvent) => void
}): Promise<void> {
  emit({
    type: 'ws:enqueue',
    projectId: context.projectId,
    userId: context.userId,
    connectionId: payload.socketId,
    socketId: payload.socketId,
  })

  try {
    const seq = await room.runtime.enqueue(new Uint8Array(payload.update))
    if (payload.connection) {
      sendAck(payload.connection, room.projectId, seq, emit)
    }
  } catch {
    // Runtime state transitions are broadcast separately. No premature ACK.
  }
}

function handleRuntimeStateChange(
  room: RoomState,
  state: ProjectRuntimeState,
  {
    emit,
    isShuttingDown,
  }: {
    emit: (event: RealtimeServerEvent) => void
    isShuttingDown: () => boolean
  },
): void {
  applyRoomReadOnly(room, isShuttingDown() || !runtimeCanAcceptMutation(room.runtime))
  broadcastRoomStatus(room, state, emit)
}

function sanitizeAwarenessStates(
  payload: {
    states: Map<number, Record<string, unknown>>
    socketId: string
  },
  room: RoomState,
  {
    clock,
    awarenessLockTtlMs,
    userId,
  }: {
    clock: RoomLifecycleClock
    awarenessLockTtlMs: number
    userId: string
  },
): void {
  for (const [clientId, state] of payload.states) {
    const participantId = normalizeParticipantId(state.participantId)
    const participantKey = createParticipantKey(payload.socketId, clientId)
    const sanitized: Record<string, unknown> = {
      ...state,
      userId,
    }

    rememberSocketParticipant(room, payload.socketId, participantKey)
    rememberParticipantClientId(room, participantKey, clientId)

    if (participantId) {
      sanitized.participantId = participantId
      sanitized.name = allocateGuestName(room, participantKey)
    } else {
      delete sanitized.participantId
      delete sanitized.name
    }

    const lock = sanitizeLock(state.lock, awarenessLockTtlMs, clock)
    if (lock) {
      sanitized.lock = lock
      scheduleParticipantLockExpiry(room, participantKey, clock, awarenessLockTtlMs)
    } else {
      delete sanitized.lock
      clearParticipantLockTimer(room, participantKey, clock)
    }

    payload.states.set(clientId, sanitized)
  }
}

function sanitizeLock(
  value: unknown,
  awarenessLockTtlMs: number,
  clock: RoomLifecycleClock,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const nodeId = stringOrUndefined((value as { nodeId?: unknown }).nodeId)
  if (!nodeId) {
    return null
  }

  const now = readClockNow(clock)
  return {
    ...(value as Record<string, unknown>),
    nodeId,
    observedAt: now,
    expiresAt: now + awarenessLockTtlMs,
  }
}

function scheduleParticipantLockExpiry(
  room: RoomState,
  participantKey: string,
  clock: RoomLifecycleClock,
  awarenessLockTtlMs: number,
): void {
  clearParticipantLockTimer(room, participantKey, clock)
  room.lockTimers.set(
    participantKey,
    clock.setTimeout(() => {
      room.lockTimers.delete(participantKey)
      expireParticipantLock(room, participantKey, clock)
    }, awarenessLockTtlMs),
  )
}

function expireParticipantLock(room: RoomState, participantKey: string, clock: RoomLifecycleClock): void {
  const clientIds = room.participantClientIds.get(participantKey)
  if (!clientIds || clientIds.size === 0) {
    return
  }

  for (const clientId of clientIds) {
    const state = room.doc.awareness.states.get(clientId)
    if (!state || !state.lock) {
      continue
    }

    const nextState = { ...state }
    delete nextState.lock
    replaceAwarenessState(room.doc, clientId, nextState, {
      source: 'local',
      reason: 'lock-expired',
      observedAt: readClockNow(clock),
    }, clock)
  }
}

function replaceAwarenessState(
  doc: RealtimeDocument,
  clientId: number,
  nextState: Record<string, unknown> | null,
  origin: unknown,
  clock: RoomLifecycleClock,
): void {
  const previousState = doc.awareness.states.get(clientId)
  const meta = doc.awareness.meta.get(clientId)
  if (!meta) {
    return
  }

  const nextClock = meta.clock + 1
  if (nextState === null) {
    doc.awareness.states.delete(clientId)
  } else {
    doc.awareness.states.set(clientId, nextState)
  }

  doc.awareness.meta.set(clientId, {
    clock: nextClock,
    lastUpdated: readClockNow(clock),
  })

  const added: number[] = []
  const updated: number[] = []
  const changed: number[] = []
  const removed: number[] = []

  if (nextState === null) {
    removed.push(clientId)
  } else if (previousState == null) {
    added.push(clientId)
  } else {
    updated.push(clientId)
    if (JSON.stringify(previousState) !== JSON.stringify(nextState)) {
      changed.push(clientId)
    }
  }

  if (added.length > 0 || changed.length > 0 || removed.length > 0) {
    doc.awareness.emit('change', [{ added, updated: changed, removed }, origin])
  }
  if (added.length > 0 || updated.length > 0 || removed.length > 0) {
    doc.awareness.emit('update', [{ added, updated, removed }, origin])
  }
}

function allocateGuestName(room: RoomState, participantKey: string): string {
  const existing = room.guestNumbers.get(participantKey)
  if (existing) {
    return guestName(existing)
  }

  const used = new Set(room.guestNumbers.values())
  let nextNumber = 1
  while (used.has(nextNumber)) {
    nextNumber += 1
  }

  room.guestNumbers.set(participantKey, nextNumber)
  return guestName(nextNumber)
}

function rememberSocketParticipant(room: RoomState, socketId: string, participantKey: string): void {
  const participants = room.socketParticipants.get(socketId) ?? new Set<string>()
  if (!participants.has(participantKey)) {
    participants.add(participantKey)
    room.socketParticipants.set(socketId, participants)
    room.participantRefCounts.set(participantKey, (room.participantRefCounts.get(participantKey) ?? 0) + 1)
  }
}

function rememberParticipantClientId(room: RoomState, participantKey: string, clientId: number): void {
  const clientIds = room.participantClientIds.get(participantKey) ?? new Set<number>()
  clientIds.add(clientId)
  room.participantClientIds.set(participantKey, clientIds)
}

function releaseSocketParticipants(
  room: RoomState | undefined,
  socketId: string,
  clock: RoomLifecycleClock,
): void {
  if (!room) {
    return
  }

  const participants = room.socketParticipants.get(socketId)
  if (!participants) {
    return
  }

  room.socketParticipants.delete(socketId)
  for (const participantKey of participants) {
    const remainingRefs = (room.participantRefCounts.get(participantKey) ?? 1) - 1
    if (remainingRefs > 0) {
      room.participantRefCounts.set(participantKey, remainingRefs)
      continue
    }

    room.participantRefCounts.delete(participantKey)
    room.guestNumbers.delete(participantKey)
    room.participantClientIds.delete(participantKey)
    clearParticipantLockTimer(room, participantKey, clock)
  }
}

function clearParticipantLockTimer(room: RoomState, participantKey: string, clock: RoomLifecycleClock): void {
  const timer = room.lockTimers.get(participantKey)
  if (timer) {
    room.lockTimers.delete(participantKey)
    clock.clearTimeout(timer)
  }
}

function clearRoomTimers(room: RoomState, clock: RoomLifecycleClock): void {
  for (const participantKey of room.lockTimers.keys()) {
    clearParticipantLockTimer(room, participantKey, clock)
  }
}

function applyRoomReadOnly(room: RoomState, readOnly: boolean): void {
  for (const connection of room.doc.getConnections()) {
    connection.readOnly = readOnly
  }
}

function broadcastRoomStatus(
  room: RoomState,
  status: ProjectRuntimeState,
  emit: (event: RealtimeServerEvent) => void,
): void {
  if (room.status === status && status !== 'PERSISTED') {
    return
  }

  room.status = status
  const payload = serializeStatusMessage(room.projectId, status)
  room.doc.broadcastStateless(payload)
  emit({ type: 'ws:status', projectId: room.projectId, status })
}

function sendStatusToConnection(
  connection: RealtimeConnection,
  projectId: string,
  status: ProjectRuntimeState,
  emit: (event: RealtimeServerEvent) => void,
): void {
  connection.sendStateless(serializeStatusMessage(projectId, status))
  emit({ type: 'ws:status', projectId, status, connectionId: connection.socketId, socketId: connection.socketId })
}

function sendAck(
  connection: RealtimeConnection,
  projectId: string,
  seq: number,
  emit: (event: RealtimeServerEvent) => void,
): void {
  connection.sendStateless(JSON.stringify({ type: 'ACK', status: 'PERSISTED', projectId, seq }))
  emit({
    type: 'ws:ack',
    projectId,
    connectionId: connection.socketId,
    socketId: connection.socketId,
    seq,
  })
}

function serializeStatusMessage(projectId: string, status: ProjectRuntimeState): string {
  return JSON.stringify({ type: 'STATUS', projectId, status })
}

function runtimeCanAcceptMutation(runtime: RealtimeRuntime): boolean {
  return typeof runtime.canAcceptMutation === 'function' ? runtime.canAcceptMutation() : true
}

function normalizeParticipantId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function createParticipantKey(socketId: string, clientId: number): string {
  return `${socketId}:${clientId}`
}

function guestName(number: number): string {
  return `Guest ${number}`
}

function requireConnectionContext(
  socketId: string,
  connectionContexts: Map<string, ConnectionContext>,
  documentName: string,
): ConnectionContext {
  const context = connectionContexts.get(socketId)
  if (!context) {
    throw forbidden(`missing connection context for ${documentName}`)
  }
  return context
}

function requireDocumentContext(
  documentName: string,
  context: ConnectionContext | undefined,
): ConnectionContext {
  if (!context) {
    throw forbidden(`missing document context for ${documentName}`)
  }

  const projectId = parseProjectDocumentName(documentName)
  if (context.projectId !== projectId) {
    throw forbidden(`document context mismatch for ${documentName}`)
  }

  return context
}

async function readJsonBody(request: onRequestPayload['request']): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function writeJson(response: onRequestPayload['response'], status: number, body: Record<string, unknown>): void {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

function isUniqueViolation(error: unknown): error is Error & { code: string } {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505'
}

function forbidden(reason: string): Error & { reason: string } {
  const error = new Error(reason) as Error & { reason: string }
  error.reason = reason
  return error
}

function extractSignedActionPayload(body: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (
      key === 'userId'
      || key === 'projectId'
      || key === 'timestamp'
      || key === 'nonce'
      || key === 'actionDigest'
      || key === 'signature'
    ) {
      continue
    }
    payload[key] = value
  }
  return payload
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readPort(value: string | undefined): number | undefined {
  const port = Number.parseInt(value ?? '', 10)
  return Number.isFinite(port) ? port : undefined
}

function createRoomLifecycleClock(): RoomLifecycleClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => {
      if (timer != null) {
        clearTimeout(timer as ReturnType<typeof setTimeout>)
      }
    },
  }
}

function readClockNow(clock: RoomLifecycleClock): number {
  if (typeof clock.now === 'function') {
    return clock.now()
  }

  return typeof clock.now === 'number' ? clock.now : Date.now()
}

async function startFromCli(): Promise<void> {
  const server = createRealtimeServer()
  await server.listen()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void startFromCli()
}
