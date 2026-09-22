# Canvas Video History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Video Generator node a durable, selectable history of its latest 12 unique URL-backed outputs.

**Architecture:** Store an optional `data.videoHistory` array in existing node data. Pure helpers normalize, derive legacy history, append generation results, cap entries, deduplicate URLs, and select an active result. Both server reconciliation and client polling call the same helper; the UI renders lightweight URL-backed video choices without storing thumbnails or binary data in history.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.7, React Flow 12, Yjs, Node test runner through `tsx`.

## Global Constraints

- Execute after Group/Lock so history selection can consume the shared edit guard.
- Keep at most 12 entries per Video Generator.
- Store only `id`, `outputUrl`, optional `generationId`, and `createdAt`.
- Reject `data:`, `blob:`, protocol-relative, empty, and oversized URLs.
- Do not copy base64 thumbnails, posters, blobs, or binary data into history.
- Existing active `videoThumbnail` may remain outside history and must be cleared when active output changes.
- Replaying completion for the same URL does not add or reorder an entry.
- Legacy nodes with only `outputUrl` display one deterministic derived entry without an eager migration write.
- Selection persists through functional node-data update and synchronizes through Yjs.
- Do not add dependencies, routes, migrations, Asset Library behavior, Jobs panel behavior, or Image Generator history.
- Notion MCP was unavailable during planning. Retry before execution and record unavailability without inventing task state.
- After the slice, update the selected Notion task status and implementation note if connected; otherwise report the exact Notion blocker.
- Preserve unrelated user changes and stage exact paths only.

---

### Task 1: Build the Bounded Video History Model

**Files:**
- Create: `nexoclip-app/services/spite/lib/video-history.ts`
- Create: `nexoclip-app/services/spite/lib/video-history.test.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`

**Interfaces:**

```ts
export const VIDEO_HISTORY_LIMIT = 12

export type VideoHistoryEntry = {
  id: string
  outputUrl: string
  generationId?: string
  createdAt: number
}

export type VideoGenerationCompletion = {
  generationId: string
  outputUrl: string
  createdAt: number
}

export function normalizeVideoHistory(value: unknown): VideoHistoryEntry[]
export function getVideoHistory(data: Record<string, unknown>): VideoHistoryEntry[]
export function completeVideoGeneration(
  data: Record<string, unknown>,
  completion: VideoGenerationCompletion,
): Record<string, unknown>
export function selectVideoHistoryEntry(
  data: Record<string, unknown>,
  entryId: string,
): Record<string, unknown>
```

- [ ] **Step 1: Write failing normalization tests**

Create `lib/video-history.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completeVideoGeneration,
  getVideoHistory,
  normalizeVideoHistory,
  selectVideoHistoryEntry,
} from './video-history'

test('filters malformed and non-durable history entries', () => {
  assert.deepEqual(normalizeVideoHistory([
    null,
    { id: 'inline', outputUrl: 'data:video/mp4;base64,AAAA', createdAt: 1 },
    { id: 'blob', outputUrl: 'blob:https://canvas.local/1', createdAt: 2 },
    { id: 'protocol-relative', outputUrl: '//other/video.mp4', createdAt: 3 },
    { id: 'missing-time', outputUrl: '/video.mp4' },
    {
      id: 'valid',
      outputUrl: '/api/assets/video-1/download',
      createdAt: 4,
      thumbnail: 'data:image/jpeg;base64,SHOULD_NOT_SURVIVE',
    },
  ]), [{
    id: 'valid',
    outputUrl: '/api/assets/video-1/download',
    createdAt: 4,
  }])
})

test('keeps the latest twelve unique URLs', () => {
  const entries = Array.from({ length: 13 }, (_, index) => ({
    id: `g-${index}`,
    outputUrl: `/video-${index}.mp4`,
    generationId: `g-${index}`,
    createdAt: index,
  }))
  assert.deepEqual(
    normalizeVideoHistory(entries).map(entry => entry.outputUrl),
    entries.slice(1).map(entry => entry.outputUrl),
  )
})
```

- [ ] **Step 2: Run and confirm RED**

Run from `nexoclip-app/services/spite`:

```bash
rtk npx tsx --test lib/video-history.test.ts
```

- [ ] **Step 3: Implement strict normalization**

Rules:

- accept plain-object entries only;
- ID: non-empty string, maximum 200 characters;
- URL: one-root-slash path or absolute `http:`/`https:`, maximum 8192 characters;
- timestamp: finite, non-negative number;
- optional generation ID: non-empty string, maximum 200 characters;
- discard unknown fields;
- keep the newest array occurrence for duplicate IDs or URLs;
- preserve durable array order rather than sorting timestamps;
- return the latest 12 normalized entries.

- [ ] **Step 4: Add failing legacy, completion, and selection tests**

```ts
test('derives one deterministic item for a legacy active output', () => {
  assert.deepEqual(getVideoHistory({
    outputUrl: '/api/assets/legacy/download',
    lastGenerationId: 'legacy-generation',
  }), [{
    id: 'legacy-generation',
    outputUrl: '/api/assets/legacy/download',
    generationId: 'legacy-generation',
    createdAt: 0,
  }])
})

test('does not derive an inline legacy output', () => {
  assert.deepEqual(getVideoHistory({
    outputUrl: 'data:video/mp4;base64,AAAA',
  }), [])
})

test('completion preserves legacy output and clears stale active thumbnail', () => {
  const next = completeVideoGeneration({
    outputUrl: '/old.mp4',
    lastGenerationId: 'g-old',
    videoThumbnail: 'data:image/jpeg;base64,OLD',
    videoThumbnailFor: '/old.mp4',
  }, {
    generationId: 'g-new',
    outputUrl: '/new.mp4',
    createdAt: 200,
  })

  assert.equal(next.outputUrl, '/new.mp4')
  assert.equal(next.videoThumbnail, undefined)
  assert.equal(next.videoThumbnailFor, undefined)
  assert.deepEqual(next.videoHistory, [
    { id: 'g-old', outputUrl: '/old.mp4', generationId: 'g-old', createdAt: 0 },
    { id: 'g-new', outputUrl: '/new.mp4', generationId: 'g-new', createdAt: 200 },
  ])
  assert.equal(JSON.stringify(next.videoHistory).includes('base64'), false)
})

test('replayed completion does not duplicate or reorder a URL', () => {
  const once = completeVideoGeneration({}, {
    generationId: 'g-1', outputUrl: '/one.mp4', createdAt: 100,
  })
  const replayed = completeVideoGeneration(once, {
    generationId: 'g-1', outputUrl: '/one.mp4', createdAt: 999,
  })
  assert.deepEqual(replayed.videoHistory, once.videoHistory)
})

test('selecting an older result changes output and clears stale thumbnail', () => {
  const selected = selectVideoHistoryEntry({
    outputUrl: '/new.mp4',
    videoThumbnail: 'data:image/jpeg;base64,NEW',
    videoThumbnailFor: '/new.mp4',
    videoHistory: [
      { id: 'old', outputUrl: '/old.mp4', createdAt: 1 },
      { id: 'new', outputUrl: '/new.mp4', createdAt: 2 },
    ],
  }, 'old')

  assert.equal(selected.outputUrl, '/old.mp4')
  assert.equal(selected.videoThumbnail, undefined)
  assert.equal(selected.videoThumbnailFor, undefined)
})
```

- [ ] **Step 5: Implement legacy derivation and transformations**

`getVideoHistory` returns normalized durable history first. If empty and `outputUrl` is valid, derive an entry using `lastGenerationId`, then `generationId`, then ID `legacy-output`; use `createdAt: 0`.

`completeVideoGeneration` must call existing `completeGenerationNode`, append only a new URL, cap history, set active output, and remove active thumbnail metadata only when output changes.

`selectVideoHistoryEntry` returns the original object for unknown/already-active entries; otherwise it updates `outputUrl`, writes normalized history, and removes active thumbnail metadata without reordering history.

- [ ] **Step 6: Run helper tests**

```bash
rtk npx tsx --test lib/video-history.test.ts
```

- [ ] **Step 7: Add a two-replica Yjs convergence test**

Add to `react-flow-binding.test.ts`:

```ts
test('video completion and active history selection converge', () => {
  const first = createCanvasDocument()
  upsertNode(first, {
    id: 'video-1', type: 'videoGen', position: { x: 0, y: 0 },
    data: {
      outputUrl: '/old.mp4',
      lastGenerationId: 'g-old',
      videoThumbnail: 'data:image/jpeg;base64,OLD',
      videoThumbnailFor: '/old.mp4',
    },
  })
  const second = new Y.Doc()
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first))

  const firstBinding = createReactFlowBinding(first)
  const completion = captureUpdate(first, () => {
    firstBinding.updateNodeData('video-1', current =>
      completeVideoGeneration(current, {
        generationId: 'g-new', outputUrl: '/new.mp4', createdAt: 200,
      }),
    )
  })
  Y.applyUpdate(second, completion)

  const secondBinding = createReactFlowBinding(second)
  const selection = captureUpdate(second, () => {
    secondBinding.updateNodeData('video-1', current =>
      selectVideoHistoryEntry(current, 'g-old'),
    )
  })
  Y.applyUpdate(first, selection)

  const firstData = findNode(readCanvasProjection(first), 'video-1').data
  const secondData = findNode(readCanvasProjection(second), 'video-1').data
  assert.deepEqual(firstData, secondData)
  assert.equal(firstData.outputUrl, '/old.mp4')
  assert.equal((firstData.videoHistory as unknown[]).length, 2)
  assert.equal(firstData.videoThumbnail, undefined)
  firstBinding.destroy()
  secondBinding.destroy()
})
```

- [ ] **Step 8: Run focused tests and commit**

```bash
rtk npx tsx --test lib/video-history.test.ts lib/realtime/react-flow-binding.test.ts
rtk git add lib/video-history.ts lib/video-history.test.ts lib/realtime/react-flow-binding.test.ts
rtk git commit -m "feat(canvas): add bounded video history model"
```

---

### Task 2: Integrate Authoritative and Client Completion Writers

**Files:**
- Modify: `nexoclip-app/services/spite/app/api/generate/status/route.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/video-node.tsx`
- Modify: `nexoclip-app/services/spite/lib/task-17-server-writers.test.ts`

**Interfaces:**
- Consumes `completeVideoGeneration()`.
- Adds injectable `now?: () => number` to generation-status dependencies for deterministic tests.

- [ ] **Step 1: Add failing authoritative completion test**

In `task-17-server-writers.test.ts`, seed a completed Video node with `/old` output, old generation ID, and active thumbnail fields. Inject `now: () => 2_000`. Assert the status writer patch contains:

```ts
assert.deepEqual(patches[0].set.videoHistory, [
  {
    id: 'g-old',
    outputUrl: '/api/assets/old/download',
    generationId: 'g-old',
    createdAt: 0,
  },
  {
    id: 'g-new',
    outputUrl: '/api/assets/new/download',
    generationId: 'g-new',
    createdAt: 2_000,
  },
])
assert.deepEqual(patches[0].unset, [
  'generationId',
  'videoThumbnail',
  'videoThumbnailFor',
])
```

Add a second call with the same already-completed URL/history and later clock; assert `patches.length === 0` so array allocation does not cause repeated terminal writes.

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/task-17-server-writers.test.ts
```

- [ ] **Step 3: Enrich only successful Video terminal patches**

After creating the existing terminal patch, when node type and generation kind are Video and `outputUrl` is a string:

```ts
const completedVideo = completeVideoGeneration(node.data, {
  generationId: generation.id,
  outputUrl: patch.outputUrl as string,
  createdAt: now(),
})

patch = {
  ...patch,
  videoHistory: completedVideo.videoHistory,
}
```

Compare `videoHistory` structurally before writing:

```ts
const differs = Object.entries(patch).some(([key, value]) =>
  key === 'videoHistory'
    ? JSON.stringify(node.data[key]) !== JSON.stringify(value)
    : node.data[key] !== value,
)
```

Unset active thumbnail fields on changed successful Video output. Leave Image terminal behavior unchanged.

- [ ] **Step 4: Replace both client completion transforms**

In normal polling and manual recheck, use a functional update:

```ts
updatePersistedNodeData(currentData => ({
  ...completeVideoGeneration(currentData, {
    generationId: completedGenerationId,
    outputUrl: completedUrl,
    createdAt: Date.now(),
  }),
  generationId: undefined,
}))
```

Keep immediate local `setOutputUrl(completedUrl)` for responsive playback. Do not use the helper for old URL repair because repair is not a new result.

- [ ] **Step 5: Prevent batch-created result nodes inheriting history**

When cloning source data for extra generated nodes, omit:

```ts
const {
  shotId,
  outputUrl: _dropOutput,
  videoHistory: _dropHistory,
  videoThumbnail: _dropThumbnail,
  videoThumbnailFor: _dropThumbnailFor,
  groupId: _dropGroup,
  objectLocked: _dropLock,
  ...restData
} = (self?.data || {}) as Record<string, unknown>
```

- [ ] **Step 6: Run focused regressions**

```bash
rtk npx tsx --test lib/video-history.test.ts lib/task-17-server-writers.test.ts lib/generation-node.test.ts lib/generation-node-prop-sync.test.ts lib/generation-polling.test.ts
```

- [ ] **Step 7: Commit Task 2**

```bash
rtk git add app/api/generate/status/route.ts components/canvas/nodes/video-node.tsx lib/task-17-server-writers.test.ts
rtk git commit -m "feat(canvas): persist video output history"
```

---

### Task 3: Add URL-Backed History Strip and Durable Selection

**Files:**
- Create: `nexoclip-app/services/spite/components/canvas/nodes/video-history-strip.tsx`
- Create: `nexoclip-app/services/spite/lib/video-history-strip.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/video-node.tsx`

**Interfaces:**

```ts
type VideoHistoryStripProps = {
  entries: VideoHistoryEntry[]
  activeOutputUrl: string | null
  disabled?: boolean
  onSelect: (entryId: string) => void
}
```

- [ ] **Step 1: Write failing static-render test**

Create `lib/video-history-strip.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { VideoHistoryStrip } from '../components/canvas/nodes/video-history-strip'

test('renders URL-backed choices and marks the active result', () => {
  const html = renderToStaticMarkup(createElement(VideoHistoryStrip, {
    entries: [
      { id: 'old', outputUrl: '/old.mp4', createdAt: 1 },
      { id: 'new', outputUrl: '/new.mp4', createdAt: 2 },
    ],
    activeOutputUrl: '/new.mp4',
    onSelect: () => {},
  }))

  assert.match(html, /aria-label="Video output history"/)
  assert.match(html, /src="\/old\.mp4"/)
  assert.match(html, /src="\/new\.mp4"/)
  assert.match(html, /aria-pressed="true"/)
  assert.doesNotMatch(html, /data:video/)
})
```

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/video-history-strip.test.ts
```

- [ ] **Step 3: Implement the focused strip**

- return `null` for no entries;
- render a horizontal scroll region with `aria-label="Video output history"`;
- render each entry as a semantic button with `aria-pressed`;
- resolve URLs through `resolveNodeMediaUrl`;
- render lightweight media with:

```tsx
<video
  src={resolvedUrl}
  muted
  playsInline
  preload="metadata"
  className="pointer-events-none h-full w-full object-cover"
/>
```

- do not pass posters, thumbnails, base64, delete, rename, or download actions;
- disable selection when the shared Group/Lock edit decision rejects this node.

- [ ] **Step 4: Wire VideoNode without duplicate history state**

Derive:

```ts
const videoHistory = getVideoHistory(data as Record<string, unknown>)
```

Select with the functional updater:

```ts
const handleHistorySelect = useCallback((entryId: string) => {
  if (!resolveNodeMutation('edit', [id]).allowed) return
  syncGuardRef.current.beginUserEdit()
  updatePersistedNodeData(currentData =>
    selectVideoHistoryEntry(currentData, entryId),
  )
}, [id, resolveNodeMutation, updatePersistedNodeData])
```

Place the strip immediately below the video preview. Let existing prop synchronization update local playback, lightbox, downstream media, and collaborators.

- [ ] **Step 5: Run focused tests**

```bash
rtk npx tsx --test lib/video-history.test.ts lib/video-history-strip.test.ts lib/realtime/react-flow-binding.test.ts lib/video-thumbnail.test.ts lib/video-sound.test.ts
rtk tsc --noEmit
```

- [ ] **Step 6: Commit Task 3**

```bash
rtk git add components/canvas/nodes/video-history-strip.tsx components/canvas/nodes/video-node.tsx lib/video-history-strip.test.ts
rtk git commit -m "feat(canvas): add video history selector"
```

---

### Task 4: Slice Verification

- [ ] **Step 1: Run complete checks**

```bash
rtk npm test
rtk npm run test:realtime
rtk npm run lint
rtk npm run build
```

- [ ] **Step 2: Review scope and secrets**

```bash
rtk git diff --check
rtk git status --short
rtk git diff HEAD~3 -- app/api/generate/status components/canvas/nodes lib
rtk git diff HEAD~3 | rtk grep -n -i "api[_-]key\|secret\|token" || true
```

Confirm no Asset Library, Jobs panel, Image Generator history, database, schema, package, or lockfile changes.

- [ ] **Step 3: Perform two-tab manual acceptance**

1. Load a legacy Video Generator with only `outputUrl`; confirm one item appears.
2. Seed or complete a new Video generation; confirm old and new entries appear once and new is active.
3. Select the old entry in one tab and confirm the other tab switches.
4. Reload and confirm active selection/history persist.
5. Seed 13 outputs and confirm only the latest 12 remain.
6. Replay one completion URL and confirm count/order do not change.
7. Seed malformed and inline URLs; confirm they do not render and the node does not crash.
8. Confirm history data contains no base64 thumbnail/poster/binary fields.
9. Confirm active scene-shot thumbnail follows the selected output.
10. Confirm fresh batch-result nodes do not inherit source history/group/lock metadata.
