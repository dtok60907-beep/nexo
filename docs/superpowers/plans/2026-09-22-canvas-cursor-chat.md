# Canvas Cursor Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add temporary Figma-style cursor chat over the existing Hocuspocus awareness channel, including server validation, read-only support, same-scene rendering, and three-second sent-message expiry.

**Architecture:** A shared pure module owns validation, TTL, keyboard state transitions, Unicode limits, and edge-aware placement. PresenceController publishes one additional awareness field. The server sanitizes and stamps expiry without persistence. CanvasWorkspace owns local composer state; the existing realtime presence overlay renders local and remote bubbles.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.7, React Flow 12, Yjs awareness, Hocuspocus 4.6, Node test runner through `tsx`.

## Global Constraints

- Execute after the four durable canvas slices.
- Cursor chat is awareness-only.
- Do not add routes, database tables, migrations, Yjs document fields, queues, protocols, WebSocket channels, dependencies, repository writes, or projector changes.
- Text is plain, single-line, normalized, and limited to 160 Unicode code points.
- Typing TTL is exactly 30,000ms; sent TTL is exactly 3,000ms.
- Ignore client-supplied expiry.
- Repeated cursor packets with unchanged `(id, revision)` do not extend expiry.
- Read-only participants may use cursor chat.
- Reuse the existing one-second presence projection tick; do not add per-message timers.
- Chat is visible only to collaborators in the same active scene.
- Notion MCP was unavailable during planning. Retry before execution and record unavailability without inventing task state.
- After the slice, update the selected Notion task status and implementation note if connected; otherwise report the exact Notion blocker.
- Preserve unrelated user changes and stage exact paths only.

---

### Task 1: Define Cursor Chat Contract, Validation, and Local State Machine

**Files:**
- Create: `nexoclip-app/services/spite/lib/realtime/cursor-chat.ts`
- Create: `nexoclip-app/services/spite/lib/realtime/cursor-chat.test.ts`

**Interfaces:**

```ts
export const CURSOR_CHAT_MAX_CODE_POINTS = 160
export const CURSOR_CHAT_MAX_ID_LENGTH = 128
export const CURSOR_CHAT_TYPING_TTL_MS = 30_000
export const CURSOR_CHAT_SENT_TTL_MS = 3_000

export type CursorChat = {
  id: string
  revision: number
  phase: 'typing' | 'sent'
  text: string
  expiresAt?: number
}

export type CursorChatPublication = Omit<CursorChat, 'expiresAt'>
export type CursorChatVersion = Pick<CursorChat, 'id' | 'revision'>

export type LocalCursorChatState =
  | { mode: 'closed' }
  | { mode: 'composing'; id: string; revision: number; draft: string }
  | { mode: 'sent'; chat: Required<CursorChat> }

export type CursorChatEffect =
  | { type: 'none' }
  | { type: 'publish'; chat: CursorChatPublication }
  | { type: 'clear'; expected?: CursorChatVersion }

export type CursorChatTransition = {
  state: LocalCursorChatState
  effect: CursorChatEffect
}
```

Required helpers:

```ts
export function truncateCursorChatDraft(text: string): string
export function normalizeCursorChatText(value: unknown): string | null
export function sanitizeCursorChat(
  value: unknown,
  previousValue: unknown,
  now: number,
): CursorChat | null
export function readActiveCursorChat(value: unknown, now: number): CursorChat | undefined
export function createCursorChatId(createId?: () => string): string
export function shouldOpenCursorChat(event: KeyboardShortcutEvent, pointerInside: boolean): boolean
export function cursorChatComposerCommand(
  event: { key: string; isComposing: boolean },
): 'submit' | 'cancel' | null
export function openLocalCursorChat(
  current: LocalCursorChatState,
  id: string,
): CursorChatTransition
export function updateLocalCursorChat(
  current: LocalCursorChatState,
  rawDraft: string,
): CursorChatTransition
export function submitLocalCursorChat(
  current: LocalCursorChatState,
  now: number,
): CursorChatTransition
export function clearLocalCursorChat(
  current: LocalCursorChatState,
): CursorChatTransition
export function expireLocalCursorChat(
  current: LocalCursorChatState,
  now: number,
): CursorChatTransition
export function placeCursorChat(
  anchor: { x: number; y: number },
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  gap?: number,
  margin?: number,
): {
  left: number
  top: number
  horizontal: 'left' | 'right'
  vertical: 'above' | 'below'
}
```

- [ ] **Step 1: Write failing validation and TTL tests**

Create `cursor-chat.test.ts`:

```ts
test('normalizes whitespace and truncates by Unicode code point', () => {
  const text = normalizeCursorChatText(`  hello\n\tworld  ${'🙂'.repeat(200)}`)
  assert.ok(text)
  assert.equal(text.startsWith('hello world '), true)
  assert.equal(Array.from(text).length, 160)
})

test('stamps typing and sent expiry from server time', () => {
  assert.deepEqual(sanitizeCursorChat(
    { id: 'chat-1', revision: 1, phase: 'typing', text: ' hello ' },
    null,
    1_000,
  ), {
    id: 'chat-1', revision: 1, phase: 'typing', text: 'hello', expiresAt: 31_000,
  })

  assert.equal(sanitizeCursorChat(
    { id: 'chat-2', revision: 1, phase: 'sent', text: 'done', expiresAt: 999_999 },
    null,
    1_000,
  )?.expiresAt, 4_000)
})

test('unchanged version preserves accepted content and expiry', () => {
  const previous = {
    id: 'chat-1', revision: 4, phase: 'sent' as const,
    text: 'accepted', expiresAt: 4_000,
  }
  assert.deepEqual(sanitizeCursorChat({
    id: 'chat-1', revision: 4, phase: 'typing',
    text: 'forged replacement', expiresAt: 999_999,
  }, previous, 2_000), previous)
})

test('rejects malformed identity, revision, phase, and blank text', () => {
  assert.equal(sanitizeCursorChat({}, null, 1_000), null)
  assert.equal(sanitizeCursorChat(
    { id: 'bad id', revision: 1, phase: 'sent', text: 'x' }, null, 1_000,
  ), null)
  assert.equal(sanitizeCursorChat(
    { id: 'chat-1', revision: 1.5, phase: 'sent', text: 'x' }, null, 1_000,
  ), null)
  assert.equal(sanitizeCursorChat(
    { id: 'chat-1', revision: 1, phase: 'other', text: 'x' }, null, 1_000,
  ), null)
  assert.equal(sanitizeCursorChat(
    { id: 'chat-1', revision: 1, phase: 'sent', text: ' \n ' }, null, 1_000,
  ), null)
})
```

- [ ] **Step 2: Add failing keyboard, transition, expiry, and placement tests**

```ts
test('slash opens only over canvas without modifiers or editable focus', () => {
  assert.equal(shouldOpenCursorChat(shortcut('/'), true), true)
  assert.equal(shouldOpenCursorChat(shortcut('/', { repeat: true }), true), false)
  assert.equal(shouldOpenCursorChat(shortcut('/', { metaKey: true }), true), false)
  assert.equal(shouldOpenCursorChat(shortcut('/', {
    target: { tagName: 'INPUT' },
  }), true), false)
  assert.equal(shouldOpenCursorChat(shortcut('/'), false), false)
})

test('IME composition prevents Enter submission', () => {
  assert.equal(cursorChatComposerCommand({ key: 'Enter', isComposing: true }), null)
  assert.equal(cursorChatComposerCommand({ key: 'Enter', isComposing: false }), 'submit')
  assert.equal(cursorChatComposerCommand({ key: 'Escape', isComposing: false }), 'cancel')
})

test('draft and sent transitions advance revisions', () => {
  const opened = openLocalCursorChat({ mode: 'closed' }, 'chat-1')
  const typing = updateLocalCursorChat(opened.state, 'hello')
  const sent = submitLocalCursorChat(typing.state, 1_000)

  assert.deepEqual(typing.effect, {
    type: 'publish',
    chat: { id: 'chat-1', revision: 1, phase: 'typing', text: 'hello' },
  })
  assert.deepEqual(sent.effect, {
    type: 'publish',
    chat: { id: 'chat-1', revision: 2, phase: 'sent', text: 'hello' },
  })
  assert.equal(sent.state.mode === 'sent' ? sent.state.chat.expiresAt : null, 4_000)
})

test('sent expiry requests a version-guarded clear', () => {
  const state: LocalCursorChatState = {
    mode: 'sent',
    chat: {
      id: 'chat-1', revision: 2, phase: 'sent',
      text: 'hello', expiresAt: 4_000,
    },
  }
  assert.deepEqual(expireLocalCursorChat(state, 4_000).effect, {
    type: 'clear', expected: { id: 'chat-1', revision: 2 },
  })
})

test('placement flips and clamps near viewport edges', () => {
  assert.deepEqual(placeCursorChat(
    { x: 790, y: 590 },
    { width: 240, height: 80 },
    { width: 800, height: 600 },
  ), {
    left: 538, top: 498, horizontal: 'left', vertical: 'above',
  })
})
```

- [ ] **Step 3: Run and confirm RED**

Run from `nexoclip-app/services/spite`:

```bash
rtk npx tsx --test lib/realtime/cursor-chat.test.ts
```

- [ ] **Step 4: Implement exact validation rules**

- ID matches `/^[A-Za-z0-9_-]{1,128}$/`.
- Revision is a non-negative safe integer.
- Phase is exactly `typing` or `sent`.
- Normalize text with `text.replace(/\s+/gu, ' ').trim()`.
- Truncate with `Array.from(normalized).slice(0, 160).join('')`.
- Empty text is invalid.
- Drop unknown fields.
- Ignore incoming `expiresAt`.
- Same `(id, revision)` returns the prior accepted object unchanged.
- Active projection requires finite future `expiresAt`.

- [ ] **Step 5: Implement pure local transitions**

- `/` opens a new composing state with revision 0.
- Each non-empty draft change increments revision and publishes `typing`.
- Empty draft clears remote chat but leaves composer open.
- Enter on non-empty increments revision, publishes `sent`, closes input, and stores local preview expiry `now + 3_000`.
- Empty Enter and Escape clear/close.
- Expiry returns a version-guarded clear.
- `placeCursorChat` prefers right/below, flips near edges, and clamps to an 8px margin with 12px gap defaults.

- [ ] **Step 6: Run and commit Task 1**

```bash
rtk npx tsx --test lib/realtime/cursor-chat.test.ts
rtk git add lib/realtime/cursor-chat.ts lib/realtime/cursor-chat.test.ts
rtk git commit -m "feat(spite): define cursor chat contract"
```

---

### Task 2: Extend Presence Projection, Publication, and Disconnect Cleanup

**Files:**
- Modify: `nexoclip-app/services/spite/lib/realtime/presence.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/presence.test.ts`
- Modify: `nexoclip-app/services/spite/hooks/use-realtime-canvas.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`

**Interfaces:**

Add to projected peer:

```ts
cursorChat?: CursorChat
```

Add to `PresenceController`:

```ts
publishCursorChat(chat: CursorChatPublication): void
clearCursorChat(expected?: CursorChatVersion): boolean
```

Add room connection state:

```ts
export type RealtimeConnectionStatus =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED'
```

- [ ] **Step 1: Write failing projection and controller tests**

```ts
test('presence projection keeps valid active chat and drops expired chat only', () => {
  const peer = projectRemotePresence({
    participantId: 'alpha',
    cursor: { x: 10, y: 20 },
    cursorChat: {
      id: 'chat-1', revision: 1, phase: 'sent', text: 'hello', expiresAt: 4_000,
    },
  }, 3_000)
  assert.equal(peer?.cursorChat?.text, 'hello')

  const expired = projectRemotePresence({
    participantId: 'alpha',
    cursor: { x: 10, y: 20 },
    cursorChat: {
      id: 'chat-1', revision: 1, phase: 'sent', text: 'hello', expiresAt: 4_000,
    },
  }, 4_000)
  assert.equal(expired?.cursorChat, undefined)
  assert.deepEqual(expired?.cursor, { x: 10, y: 20 })
})

test('controller publishes without client expiry and guards stale clear', () => {
  const awareness = new FakeAwareness()
  const controller = createPresenceController({ awareness, participantId: 'alpha' })
  controller.publishCursorChat({
    id: 'chat-1', revision: 1, phase: 'typing', text: 'first',
  })
  controller.publishCursorChat({
    id: 'chat-1', revision: 2, phase: 'sent', text: 'second',
  })

  assert.equal(controller.clearCursorChat({ id: 'chat-1', revision: 1 }), false)
  assert.equal(awareness.getLocalState()?.cursorChat.revision, 2)
  assert.equal(controller.clearCursorChat({ id: 'chat-1', revision: 2 }), true)
  assert.equal(awareness.getLocalState()?.cursorChat, null)
})
```

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/realtime/presence.test.ts
```

- [ ] **Step 3: Implement projection and controller methods**

`projectRemotePresence` calls `readActiveCursorChat(peer.cursorChat, now)` and keeps the participant/cursor even when chat is invalid or expired.

`publishCursorChat` remembers the latest local version and calls `awareness.setLocalStateField('cursorChat', chat)` without expiry. `clearCursorChat(expected)` rejects stale expected versions; accepted clear writes `null`.

- [ ] **Step 4: Add failing disconnect lifecycle test**

Extend the existing fake provider/awareness in `react-flow-binding.test.ts`:

```ts
test('realtime disconnect clears cursor chat before reconnect', () => {
  const room = getOrCreateRealtimeCanvasRoom(projectId, options)
  const provider = createdProviders[0]
  provider.awareness.setLocalState({
    participantId: 'alpha',
    cursorChat: {
      id: 'chat-1', revision: 1, phase: 'sent', text: 'temporary',
    },
  })

  provider.emitDisconnect()
  assert.equal(provider.awareness.getLocalState()?.cursorChat, null)
  assert.equal(room.getSnapshot().connectionStatus, 'DISCONNECTED')

  provider.emitConnect()
  assert.equal(room.getSnapshot().connectionStatus, 'CONNECTED')
  assert.equal(provider.awareness.getLocalState()?.cursorChat, null)
})
```

- [ ] **Step 5: Implement connection status and cleanup**

- initial `CONNECTING`;
- provider connect → `CONNECTED` and emit snapshot;
- provider disconnect → clear awareness `cursorChat`, set `DISCONNECTED`, emit snapshot;
- reconnect leaves chat null;
- room unmount clears chat before provider destruction.

Do not alter Yjs synchronization or persistence status.

- [ ] **Step 6: Run and commit Task 2**

```bash
rtk npx tsx --test lib/realtime/presence.test.ts lib/realtime/react-flow-binding.test.ts
rtk git add lib/realtime/presence.ts lib/realtime/presence.test.ts hooks/use-realtime-canvas.ts lib/realtime/react-flow-binding.test.ts
rtk git commit -m "feat(spite): clear cursor chat on disconnect"
```

---

### Task 3: Sanitize Awareness on the Realtime Server

**Files:**
- Modify: `nexoclip-app/services/spite/realtime/server.ts`
- Modify: `nexoclip-app/services/spite/realtime/server-lifecycle.test.ts`
- Modify: `nexoclip-app/services/spite/realtime/collaboration.integration.test.ts`

- [ ] **Step 1: Add failing server lifecycle test**

Use the file's existing fake clock and connected sender/observer helpers. Publish a forged payload and assert:

```ts
assert.deepEqual(observerState.cursorChat, {
  id: 'chat-1',
  revision: 1,
  phase: 'typing',
  text: 'hello world',
  expiresAt: 31_000,
})
```

Advance clock to 5,000ms, send cursor movement with the unchanged chat version, and assert expiry remains 31,000ms. Send revision 2 with phase `sent` and assert expiry is 8,000ms. Send a malformed blank chat with a valid cursor and assert the cursor remains while `cursorChat` disappears. Add an emoji payload and assert exactly 160 code points.

- [ ] **Step 2: Extend the read-only awareness test**

Publish chat from a read-only provider and assert the peer receives it while:

```ts
assert.equal(runtime.enqueueCalls.length, 0)
assert.equal(repository.appendCalls.length, 0)
```

- [ ] **Step 3: Add awareness-only restart integration test**

Connect two clients, publish typing revision 1 then sent revision 2, and assert observer transitions. Before restart assert no repository append/projection writes. Restart using the existing repository, connect a fresh observer, and assert no awareness state contains `cursorChat` and durable canvas projection is unchanged.

- [ ] **Step 4: Run and confirm RED**

```bash
rtk npx tsx --test --test-name-pattern="cursor chat|read-only" realtime/server-lifecycle.test.ts realtime/collaboration.integration.test.ts
```

- [ ] **Step 5: Implement server sanitation**

Inside `beforeHandleAwareness`, compare incoming state with the previously accepted state:

```ts
const previousCursorChat =
  room.doc.awareness.states.get(clientId)?.cursorChat
const cursorChat = sanitizeCursorChat(
  state.cursorChat,
  previousCursorChat,
  readClockNow(clock),
)

if (cursorChat) sanitized.cursorChat = cursorChat
else delete sanitized.cursorChat
```

Keep all valid identity, cursor, scene, selection, and lock fields. Do not add server timers or room maps.

- [ ] **Step 6: Run and commit Task 3**

```bash
rtk npx tsx --test realtime/server-lifecycle.test.ts
rtk npx tsx --test --test-name-pattern="cursor chat" realtime/collaboration.integration.test.ts
rtk git add realtime/server.ts realtime/server-lifecycle.test.ts realtime/collaboration.integration.test.ts
rtk git commit -m "feat(spite): sanitize cursor chat awareness"
```

---

### Task 4: Wire Slash Shortcut, Local Composer, and Cursor Overlay

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/realtime-presence.tsx`
- Modify: `nexoclip-app/services/spite/lib/realtime/cursor-chat.test.ts`

**Interfaces:**

Extend overlay props:

```ts
type RealtimePresenceProps = {
  peers: RemotePresencePeer[]
  nodes: Node[]
  viewport: ViewportLike
  localCursor: PresencePoint | null
  localCursorChat: LocalCursorChatState
  onLocalDraftChange: (value: string) => void
  onLocalSubmit: () => void
  onLocalCancel: () => void
}
```

- [ ] **Step 1: Keep local state and publication synchronized**

Add local cursor state/ref, pointer-inside ref, and local cursor-chat state/ref. Use one dispatcher:

```ts
const applyCursorChatTransition = useCallback(
  (transition: CursorChatTransition) => {
    localCursorChatRef.current = transition.state
    setLocalCursorChat(transition.state)

    if (transition.effect.type === 'publish') {
      presenceControllerRef.current?.publishCursorChat(transition.effect.chat)
    }
    if (transition.effect.type === 'clear') {
      presenceControllerRef.current?.clearCursorChat(transition.effect.expected)
    }
  },
  [],
)
```

- [ ] **Step 2: Handle `/` before generic editable-element early return**

```ts
if (shouldOpenCursorChat(
  event,
  pointerInsideCanvasRef.current && localCursorRef.current !== null,
)) {
  event.preventDefault()
  applyCursorChatTransition(openLocalCursorChat(
    localCursorChatRef.current,
    createCursorChatId(),
  ))
  return
}
```

Do not gate this path on `allowDocumentMutation`.

- [ ] **Step 3: Update pointer and expiry lifecycle**

On pointer move, update local flow coordinates and publish cursor. On pointer leave, clear local cursor, chat, and awareness cursor. On unmount, clear chat before destroying the controller. On disconnected connection status, close local UI without a document command.

Use the existing one-second `presenceNow` tick:

```ts
useEffect(() => {
  const transition = expireLocalCursorChat(
    localCursorChatRef.current,
    presenceNow,
  )
  if (transition.effect.type !== 'none') {
    applyCursorChatTransition(transition)
  }
}, [applyCursorChatTransition, presenceNow])
```

- [ ] **Step 4: Filter overlay peers by active scene**

Keep all peers for guest/follow UI. Pass only:

```ts
const activeScenePresence = useMemo(
  () => remotePresence.filter(peer => peer.sceneId === activeSceneId),
  [activeSceneId, remotePresence],
)
```

to `RealtimePresenceOverlay`.

- [ ] **Step 5: Render remote and local cursor chat safely**

Remote bubbles render only when cursor and active chat exist, reuse participant color, and render `{peer.cursorChat.text}` as React text. Never use HTML, markdown, or links.

Local composing mode renders:

```tsx
<input
  autoFocus
  aria-label="Cursor chat message"
  value={localCursorChat.draft}
  onChange={event => onLocalDraftChange(event.target.value)}
  onBlur={onLocalCancel}
/>
```

Track IME composition and check `nativeEvent.isComposing` before Enter submission. After successful submit, blur/unmount must not clear the newly sent revision; consult the synchronous state ref.

- [ ] **Step 6: Add edge-aware positioning**

Use `ResizeObserver` on overlay and bubble/composer dimensions. Pass actual sizes to `placeCursorChat`. Overlay remains `pointer-events-none`; local input alone uses `pointer-events-auto`. Preserve `overflow-hidden` and clamp to 8px.

- [ ] **Step 7: Run tests, types, lint, and commit**

```bash
rtk npx tsx --test lib/realtime/cursor-chat.test.ts lib/realtime/presence.test.ts
rtk tsc --noEmit
rtk npm run lint
rtk git add components/canvas/canvas-workspace.tsx components/canvas/realtime-presence.tsx lib/realtime/cursor-chat.test.ts
rtk git commit -m "feat(spite): add cursor chat composer"
```

---

### Task 5: Slice Verification

- [ ] **Step 1: Run complete checks**

```bash
rtk npm test
rtk npm run test:realtime
rtk npm run lint
rtk npm run build
```

- [ ] **Step 2: Confirm persistence boundaries remain untouched**

```bash
rtk git diff HEAD~4 -- app/api database-setup.sql lib/realtime/document.ts lib/realtime/react-flow-binding.ts realtime/projector.ts realtime/yjs-repository.ts package.json pnpm-lock.yaml
```

Expected: no route, document, projector, repository, schema, dependency, or lockfile changes.

- [ ] **Step 3: Review diff and secrets**

```bash
rtk git diff --check
rtk git status --short
rtk git diff HEAD~4 -- components/canvas hooks lib/realtime realtime
rtk git diff HEAD~4 | rtk grep -n -i "api[_-]key\|secret\|token" || true
```

- [ ] **Step 4: Perform two-tab manual acceptance**

1. Put both tabs in the same scene and confirm existing cursor/name behavior.
2. Press `/`; confirm composer opens beside local cursor.
3. Move while typing; confirm local composer and remote draft follow cursor.
4. Paste whitespace/multiline text and confirm remote normalized single line.
5. Enter more than 160 code points including emoji and confirm code-point truncation.
6. Press Enter during IME composition and confirm no submission.
7. Submit normally and confirm expiry after three to four seconds, allowing the one-second projection tick.
8. Keep moving after send and confirm expiry does not extend.
9. Escape, blur, leave canvas, navigate, disconnect, and reconnect; confirm chat clears.
10. Put one tab in another scene and confirm chat does not render cross-scene.
11. Put room in read-only state and confirm chat works while node mutation remains blocked.
12. Restart realtime server and confirm no chat history recovers.
13. Confirm repository/projector instrumentation records no write caused by chat.
