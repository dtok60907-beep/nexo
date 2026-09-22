# Canvas Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Prompt node overflow, add durable inline scene rename, label generator-input nodes as Prompt, and hide full prompt text from generator nodes.

**Architecture:** Prompt height is derived locally from measured content while the saved height remains a user-controlled minimum, avoiding Yjs writes on every keystroke. Scene rename extends the existing Yjs scene command surface. Generator prompt resolution remains unchanged; only visible prompt copies are removed.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.7, React Flow 12, Yjs 13, Hocuspocus, Node test runner through `tsx`.

## Global Constraints

- Work only under `nexoclip-app/services/spite` except this plan document.
- Do not add dependencies, migrations, provider changes, Utility nodes, grouping, video history, or cursor chat.
- Preserve Prompt node type `prompt`, menu ID `text`, and shortcut `T`.
- Prompt rendered height is `max(saved minimum or 192px, measured content)`, capped at 900px.
- Content above 900px scrolls inside the Prompt editor.
- Computed content height is not persisted on each input event.
- Scene names are plain text, trimmed, non-empty, and limited to 80 characters.
- Read-only users cannot rename scenes.
- Image and Video Generator nodes must continue validating and resolving connected prompts even though they no longer render full prompt text.
- Notion MCP was unavailable during planning. Do not invent task state; retry the task-board check before execution and record unavailability if it remains disconnected.
- After the slice, update the selected Notion task status and implementation note if connected; otherwise report the exact Notion blocker.
- Preserve unrelated user changes and stage exact paths only.

---

### Task 1: Define Prompt Height Semantics

**Files:**
- Modify: `nexoclip-app/services/spite/lib/canvas-node-interactions.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-node-interactions.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/resizable-node-frame.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/resizable-node-frame.test.ts`

**Interfaces:**
- Produces:

```ts
export const PROMPT_NODE_DEFAULT_HEIGHT = 192
export const PROMPT_NODE_MAX_HEIGHT = 900

export function resolvePromptNodeHeight(
  savedMinimumHeight: unknown,
  measuredContentHeight: number,
): number
```

- Extends resize sessions so `minimumSize` and current `renderedSize` remain distinct.

- [ ] **Step 1: Add failing Prompt height tests**

Add to `lib/canvas-node-interactions.test.ts`:

```ts
test('prompt height respects defaults, content, saved minimum, and cap', () => {
  assert.equal(resolvePromptNodeHeight(undefined, 80), 192)
  assert.equal(resolvePromptNodeHeight(320, 180), 320)
  assert.equal(resolvePromptNodeHeight(320, 540), 540)
  assert.equal(resolvePromptNodeHeight(320, 1_200), 900)
})

test('prompt height ignores invalid durable dimensions', () => {
  assert.equal(resolvePromptNodeHeight('320', 240), 240)
  assert.equal(resolvePromptNodeHeight(Number.NaN, 240), 240)
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run from `nexoclip-app/services/spite`:

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
```

Expected: failure because `resolvePromptNodeHeight` is not exported.

- [ ] **Step 3: Implement the pure height helper**

Add to `lib/canvas-node-interactions.ts`:

```ts
export const PROMPT_NODE_DEFAULT_HEIGHT = 192
export const PROMPT_NODE_MAX_HEIGHT = 900

export function resolvePromptNodeHeight(
  savedMinimumHeight: unknown,
  measuredContentHeight: number,
): number {
  const minimum =
    typeof savedMinimumHeight === 'number' && Number.isFinite(savedMinimumHeight)
      ? savedMinimumHeight
      : PROMPT_NODE_DEFAULT_HEIGHT
  const measured = Number.isFinite(measuredContentHeight)
    ? measuredContentHeight
    : 0

  return Math.min(
    PROMPT_NODE_MAX_HEIGHT,
    Math.max(PROMPT_NODE_DEFAULT_HEIGHT, minimum, measured),
  )
}
```

- [ ] **Step 4: Run the helper test and confirm GREEN**

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
```

- [ ] **Step 5: Add failing resize-session tests**

Extend `components/canvas/nodes/resizable-node-frame.test.ts`:

```ts
test('horizontal resize retains the saved minimum height', () => {
  const session = createResizeSession(
    7,
    100,
    100,
    { width: 340, height: 192 },
    { width: 340, height: 600 },
  )

  assert.deepEqual(
    resizeNodeMinimum(session, 180, 100, {
      minWidth: 180,
      minHeight: 192,
      maxWidth: 900,
      maxHeight: 900,
    }),
    { width: 420, height: 192 },
  )
})

test('vertical resize starts from rendered content height', () => {
  const session = createResizeSession(
    7,
    100,
    100,
    { width: 340, height: 192 },
    { width: 340, height: 600 },
  )

  assert.deepEqual(
    resizeNodeMinimum(session, 100, 150, {
      minWidth: 180,
      minHeight: 192,
      maxWidth: 900,
      maxHeight: 900,
    }),
    { width: 340, height: 650 },
  )
})
```

- [ ] **Step 6: Run the frame test and confirm RED**

```bash
rtk npx tsx --test components/canvas/nodes/resizable-node-frame.test.ts
```

Expected: the existing resize-session signature cannot distinguish minimum and rendered height.

- [ ] **Step 7: Extend the frame contract minimally**

Add optional `renderedHeight?: number` to `ResizableNodeFrameProps`. Extend `createResizeSession` to store:

```ts
type ResizeSession = {
  pointerId: number
  startX: number
  startY: number
  minimumSize: NodeSize
  renderedSize: NodeSize
}
```

Use the rendered size as the vertical drag origin, but return/persist the user-selected minimum size. Render the frame with:

```ts
const displayedHeight = Math.min(
  bounds.maxHeight,
  Math.max(size.height, renderedHeight ?? size.height),
)
```

Cancellation restores `minimumSize`; successful pointer-up persists only the resized minimum.

- [ ] **Step 8: Run both focused suites**

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
rtk npx tsx --test components/canvas/nodes/resizable-node-frame.test.ts
```

- [ ] **Step 9: Commit Task 1**

```bash
rtk git add lib/canvas-node-interactions.ts lib/canvas-node-interactions.test.ts components/canvas/nodes/resizable-node-frame.tsx components/canvas/nodes/resizable-node-frame.test.ts
rtk git commit -m "feat(canvas): define prompt auto sizing"
```

---

### Task 2: Wire Prompt Content Measurement

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/mention-textarea.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/prompt-node.tsx`
- Create: `nexoclip-app/services/spite/lib/canvas-correctness-wiring.test.ts`

**Interfaces:**
- Extends `MentionTextareaRef`:

```ts
export interface MentionTextareaRef {
  focus: () => void
  getElement: () => HTMLDivElement | null
}
```

- Consumes `resolvePromptNodeHeight()` and `ResizableNodeFrame.renderedHeight` from Task 1.

- [ ] **Step 1: Write the failing wiring contract test**

Create `lib/canvas-correctness-wiring.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const textarea = read('../components/canvas/mention-textarea.tsx')
const prompt = read('../components/canvas/nodes/prompt-node.tsx')

test('mention textarea exposes its contenteditable element', () => {
  assert.match(textarea, /getElement:\s*\(\) => editorRef\.current/)
})

test('prompt measures content without persisting calculated height', () => {
  assert.match(prompt, /ResizeObserver/)
  assert.match(prompt, /scrollHeight/)
  assert.match(prompt, /resolvePromptNodeHeight/)
  assert.match(prompt, /renderedHeight=\{promptHeight\}/)
  assert.match(prompt, /updateNodeInternals\(id\)/)
  assert.doesNotMatch(prompt, /patchNodeData\(id, \{ text, mentions, height/)
})

test('prompt contains oversized content instead of overflowing its card', () => {
  assert.match(prompt, /max-h-\[900px\]/)
  assert.match(prompt, /overflow-y-auto/)
  assert.match(prompt, /overflow-hidden/)
})
```

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/canvas-correctness-wiring.test.ts
```

- [ ] **Step 3: Expose the editor element**

Update `useImperativeHandle` in `mention-textarea.tsx`:

```ts
useImperativeHandle(outerRef, () => ({
  focus: () => editorRef.current?.focus(),
  getElement: () => editorRef.current,
}))
```

- [ ] **Step 4: Measure Prompt content locally**

In `prompt-node.tsx`:

1. Import `useUpdateNodeInternals` and `resolvePromptNodeHeight`.
2. Track measured content height in local state.
3. After local or remote `text`/`mentions` changes, schedule one `requestAnimationFrame` measurement.
4. Observe the editor and card with `ResizeObserver`.
5. Call `updateNodeInternals(id)` when rendered geometry changes.
6. Pass the derived height to `ResizableNodeFrame`.

Representative implementation:

```ts
const updateNodeInternals = useUpdateNodeInternals()
const [measuredContentHeight, setMeasuredContentHeight] = useState(0)

const measureContent = useCallback(() => {
  setMeasuredContentHeight(
    editorRef.current?.getElement()?.scrollHeight ?? 0,
  )
}, [])

const promptHeight = resolvePromptNodeHeight(
  data.height,
  measuredContentHeight,
)

useEffect(() => {
  const frame = window.requestAnimationFrame(measureContent)
  return () => window.cancelAnimationFrame(frame)
}, [measureContent, mentions, text])

useEffect(() => {
  if (typeof ResizeObserver === 'undefined') return

  const observer = new ResizeObserver(() => {
    measureContent()
    updateNodeInternals(id)
  })
  const editor = editorRef.current?.getElement()

  if (editor) observer.observe(editor)
  if (cardRef.current) observer.observe(cardRef.current)

  return () => observer.disconnect()
}, [id, measureContent, updateNodeInternals])
```

Set Prompt bounds `minHeight` to `192`, give the card `overflow-hidden`, and give the contenteditable wrapper `max-h-[900px] overflow-y-auto`. Do not write computed height in `handleChange`.

- [ ] **Step 5: Run focused tests**

```bash
rtk npx tsx --test lib/canvas-correctness-wiring.test.ts
rtk npx tsx --test lib/canvas-node-interactions.test.ts
rtk npx tsx --test components/canvas/nodes/resizable-node-frame.test.ts
```

- [ ] **Step 6: Run lint**

```bash
rtk npm run lint
```

- [ ] **Step 7: Commit Task 2**

```bash
rtk git add components/canvas/mention-textarea.tsx components/canvas/nodes/prompt-node.tsx lib/canvas-correctness-wiring.test.ts
rtk git commit -m "feat(canvas): auto-size prompt content"
```

---

### Task 3: Add Durable Scene Rename

**Files:**
- Modify: `nexoclip-app/services/spite/lib/canvas-node-interactions.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-node-interactions.test.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`
- Modify: `nexoclip-app/services/spite/hooks/use-realtime-canvas.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-runtime-ui.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-runtime-ui.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/scene-timeline.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx`
- Modify: `nexoclip-app/services/spite/lib/canvas-correctness-wiring.test.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_SCENE_NAME_LENGTH = 80
export function normalizeSceneName(name: string): string | null
```

- Adds to realtime commands:

```ts
renameScene(sceneId: string, name: string): void
```

- Adds timeline props:

```ts
readOnly: boolean
onRenameScene: (sceneId: string, name: string) => void
```

- [ ] **Step 1: Add failing normalization tests**

```ts
test('scene names are trimmed, capped, and non-empty', () => {
  assert.equal(normalizeSceneName('  Opening Beat  '), 'Opening Beat')
  assert.equal(normalizeSceneName('x'.repeat(81)), 'x'.repeat(80))
  assert.equal(normalizeSceneName('   '), null)
})
```

- [ ] **Step 2: Add a failing Yjs replication test**

Add to `lib/realtime/react-flow-binding.test.ts` using the file's existing document helpers:

```ts
test('renameScene persists and replicates normalized scene metadata', () => {
  const primary = createCanvasDocument()
  setScenes(primary, [
    { id: 'scene-1', name: 'Scene 1' },
    { id: 'scene-2', name: 'Scene 2' },
  ])
  const replica = new Y.Doc()
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(primary))

  const binding = createReactFlowBinding(primary)
  const update = captureUpdate(primary, () => {
    binding.renameScene('scene-2', '  Opening Beat  ')
  })
  Y.applyUpdate(replica, update)

  assert.equal(readCanvasProjection(primary).scenes[1].name, 'Opening Beat')
  assert.equal(readCanvasProjection(replica).scenes[1].name, 'Opening Beat')

  binding.renameScene('scene-2', '   ')
  assert.equal(readCanvasProjection(primary).scenes[1].name, 'Opening Beat')
  binding.destroy()
})
```

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
rtk npx tsx --test lib/realtime/react-flow-binding.test.ts
```

- [ ] **Step 4: Implement normalization and binding command**

```ts
export const MAX_SCENE_NAME_LENGTH = 80

export function normalizeSceneName(name: string): string | null {
  const normalized = name.trim().slice(0, MAX_SCENE_NAME_LENGTH)
  return normalized || null
}
```

Implement `renameScene` by reading the current projection, returning for a missing scene, invalid name, or unchanged name, and replacing only the matching scene through the existing scene metadata writer in one Yjs transaction.

- [ ] **Step 5: Propagate the command through runtime layers**

Add `renameScene` to:

1. binding mutation and public command types;
2. `RealtimeCanvasCommands`;
3. `EMPTY_COMMANDS`;
4. room command forwarding in `use-realtime-canvas.ts`;
5. `READ_ONLY_COMMANDS` as a no-op;
6. invocation-time runtime controls.

Update `canvas-runtime-ui.test.ts` so writable mode forwards one rename call and read-only mode forwards none.

- [ ] **Step 6: Add inline timeline editing**

Use this local state:

```ts
type SceneRenameDraft = {
  sceneId: string
  originalName: string
  value: string
}
```

Writable scene names render a button that enters edit mode. Edit mode renders an autofocus input with `maxLength={80}`. Stop propagation so renaming does not switch scenes. Enter and valid blur save; Escape cancels; an invalid blank value restores the old name. Read-only mode always renders static text.

- [ ] **Step 7: Wire the workspace**

Add a handler guarded by `allowDocumentMutation`:

```ts
const handleRenameScene = useCallback((sceneId: string, name: string) => {
  if (!allowDocumentMutation) return
  commands.renameScene(sceneId, name)
}, [allowDocumentMutation, commands])
```

Pass `readOnly={!allowDocumentMutation}` and `onRenameScene={handleRenameScene}` to `SceneTimeline`.

- [ ] **Step 8: Extend the source contract test**

Assert that `scene-timeline.tsx` contains `maxLength={MAX_SCENE_NAME_LENGTH}`, Enter/Escape branches, and `onRenameScene`, and that `canvas-workspace.tsx` passes the read-only prop.

- [ ] **Step 9: Run focused and realtime tests**

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
rtk npx tsx --test lib/realtime/react-flow-binding.test.ts
rtk npx tsx --test lib/canvas-runtime-ui.test.ts
rtk npx tsx --test lib/canvas-correctness-wiring.test.ts
rtk npm run test:realtime
```

- [ ] **Step 10: Commit Task 3**

```bash
rtk git add lib/canvas-node-interactions.ts lib/canvas-node-interactions.test.ts lib/realtime/react-flow-binding.ts lib/realtime/react-flow-binding.test.ts hooks/use-realtime-canvas.ts lib/canvas-runtime-ui.ts lib/canvas-runtime-ui.test.ts components/canvas/scene-timeline.tsx components/canvas/canvas-workspace.tsx lib/canvas-correctness-wiring.test.ts
rtk git commit -m "feat(canvas): add durable scene renaming"
```

---

### Task 4: Hide Generator Prompt Details and Relabel Prompt

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/add-node-menu.tsx`
- Modify: `nexoclip-app/services/spite/lib/canvas-node-interactions.ts`
- Modify: `nexoclip-app/services/spite/lib/canvas-node-interactions.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/image-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/video-node.tsx`
- Modify: `nexoclip-app/services/spite/lib/canvas-correctness-wiring.test.ts`

- [ ] **Step 1: Add failing terminology and hidden-preview tests**

Add to `lib/canvas-correctness-wiring.test.ts`:

```ts
const menu = read('../components/canvas/add-node-menu.tsx')
const image = read('../components/canvas/nodes/image-node.tsx')
const video = read('../components/canvas/nodes/video-node.tsx')

test('Basics keeps the existing prompt identity while showing Prompt', () => {
  assert.match(
    menu,
    /id:\s*'text',[\s\S]*label:\s*'Prompt',[\s\S]*shortcut:\s*'T',[\s\S]*nodeType:\s*'prompt'/,
  )
})

for (const [name, source] of [['image', image], ['video', video]] as const) {
  test(`${name} generator validates prompts without rendering full text`, () => {
    assert.match(source, /const promptState = getGenerationPromptState/)
    assert.match(source, /promptState\.disabled/)
    assert.doesNotMatch(
      source,
      /\{resolvedPrompt\.connected\s*\?\s*resolvedPrompt\.prompt/,
    )
  })
}
```

Update generation-state expectations to:

```ts
{
  connected: false,
  prompt: '',
  disabled: true,
  message: 'Connect a Prompt node first',
}
```

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
rtk npx tsx --test lib/canvas-correctness-wiring.test.ts
```

- [ ] **Step 3: Change visible terminology without changing identity**

Change only the menu label to `Prompt`. Preserve `id: 'text'`, shortcut `T`, category `BASICS`, and node type `prompt`.

Update visible generator-input copy to:

- `Connect a Prompt node first`
- `Enter text in the connected Prompt node`
- `Prompt output`
- `Prompt input`

Do not rename storage fields, internal type IDs, or the `resolvedPrompt` variable.

- [ ] **Step 4: Remove only the visible prompt blocks**

Remove the small prompt-text `<div>` from Image and Video Generator controls. Retain:

- `resolveIncomingPrompt`;
- `getGenerationPromptState`;
- disconnected/empty validation;
- submission-time prompt reads;
- generate-button disabled logic;
- model controls, voice IDs, status, errors, retries, and tooltips.

- [ ] **Step 5: Run regressions**

```bash
rtk npx tsx --test lib/canvas-node-interactions.test.ts
rtk npx tsx --test lib/canvas-correctness-wiring.test.ts
rtk npx tsx --test lib/generation-node-prop-sync.test.ts
rtk npm test
```

- [ ] **Step 6: Commit Task 4**

```bash
rtk git add components/canvas/add-node-menu.tsx lib/canvas-node-interactions.ts lib/canvas-node-interactions.test.ts components/canvas/canvas-workspace.tsx components/canvas/nodes/image-node.tsx components/canvas/nodes/video-node.tsx lib/canvas-correctness-wiring.test.ts
rtk git commit -m "fix(canvas): clarify prompt node behavior"
```

---

### Task 5: Slice Verification

- [ ] **Step 1: Run all unit tests**

```bash
rtk npm test
```

- [ ] **Step 2: Run the component-local frame suite omitted by `npm test`**

```bash
rtk npx tsx --test components/canvas/nodes/resizable-node-frame.test.ts
```

- [ ] **Step 3: Run all realtime tests**

```bash
rtk npm run test:realtime
```

- [ ] **Step 4: Run lint and production build**

```bash
rtk npm run lint
rtk npm run build
```

- [ ] **Step 5: Review the diff and secrets**

```bash
rtk git diff --check
rtk git status --short
rtk git diff HEAD~4 -- components/canvas hooks lib realtime
rtk git diff HEAD~4 | rtk grep -n -i "api[_-]key\|secret\|token" || true
```

- [ ] **Step 6: Perform two-tab manual acceptance**

1. Paste long content into a Prompt and confirm the node contains it.
2. Delete content and confirm the node shrinks only to its saved minimum.
3. Paste enough content to exceed 900px and confirm internal scrolling.
4. Resize width and minimum height; reload both tabs and verify edge alignment.
5. Rename a scene by Enter and blur; cancel with Escape; reject whitespace.
6. Reload both tabs and confirm the scene name converges.
7. Confirm read-only mode never renders the scene rename input.
8. Confirm Basics shows Prompt with shortcut `T`.
9. Confirm Image and Video Generators hide prompt text while generation validation still works.
