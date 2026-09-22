# Canvas Utilities and Visual Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free-form Utility Text and Sticky Note nodes, expose them under a Utilities menu, and improve canvas-local icon legibility.

**Architecture:** Both utilities are ordinary React Flow nodes using existing generic Yjs node data for `text`, `width`, and `height`. One shared component implements fixed Text and Sticky Note variants. Icon changes are scoped to existing canvas menus/toolbars and do not change global tokens or connection-handle geometry.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.7, React Flow 12, Yjs, Phosphor Icons, Node test runner through `tsx`.

## Global Constraints

- Execute after `2026-09-22-canvas-correctness.md` so Basics already displays Prompt.
- Add node types `utilityText` and `stickyNote`; never restore legacy type `note`.
- Utilities contains Text and Sticky Note only; do not add Table.
- Utility Text is plain free-form text, not a generator prompt.
- Sticky Note has one fixed high-contrast color; no picker, checklist, markdown, or rich text.
- Utilities have no generator handles.
- Do not add dependencies, migrations, schema changes, or global CSS-token changes.
- Keep existing toolbar button dimensions and React Flow handle containers unchanged.
- Do not implement Group/Lock in this slice; keep utility nodes compatible with ordinary selection.
- Notion MCP was unavailable during planning. Retry before execution and record unavailability without inventing task state.
- After the slice, update the selected Notion task status and implementation note if connected; otherwise report the exact Notion blocker.
- Preserve unrelated user changes and stage exact paths only.

---

### Task 1: Add Shared Utility Node Components

**Files:**
- Create: `nexoclip-app/services/spite/components/canvas/nodes/utility-nodes.tsx`
- Create: `nexoclip-app/services/spite/lib/canvas-utility-nodes.test.ts`

**Interfaces:**
- Produces:

```ts
export const UtilityTextNode
export const StickyNoteNode
```

- Durable data contract:

```ts
type UtilityNodeData = {
  label?: string
  sceneId: string
  text?: string
  width?: number
  height?: number
}
```

- Consumes existing `patchNodeData(nodeId, patch)` and `ResizableNodeFrame`.

- [ ] **Step 1: Write the failing component contract test**

Create `lib/canvas-utility-nodes.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../components/canvas/nodes/utility-nodes.tsx', import.meta.url),
  'utf8',
)

test('utility nodes share plain text editing and durable resizing', () => {
  assert.match(source, /export const UtilityTextNode = memo\(UtilityTextNodeImpl\)/)
  assert.match(source, /export const StickyNoteNode = memo\(StickyNoteNodeImpl\)/)
  assert.match(source, /<ResizableNodeFrame/)
  assert.match(source, /patchNodeData\(id, \{ text:/)
  assert.match(source, /defaultSize: \{ width: 240, height: 120 \}/)
  assert.match(source, /defaultSize: \{ width: 240, height: 200 \}/)
})

test('utility nodes have no generator handles', () => {
  assert.doesNotMatch(source, /\bHandle\b/)
  assert.doesNotMatch(source, /prompt-out|prompt-in|image-out|video-out/)
})

test('sticky notes use one fixed high contrast presentation', () => {
  assert.match(source, /background: '#F5D565'/)
  assert.match(source, /text-\[#241E0A\]/)
  assert.doesNotMatch(source, /colorPicker|data\.color|markdown/)
})
```

- [ ] **Step 2: Run and confirm RED**

Run from `nexoclip-app/services/spite`:

```bash
rtk npx tsx --test lib/canvas-utility-nodes.test.ts
```

Expected: module/file-not-found failure.

- [ ] **Step 3: Implement the shared variants**

Create `utility-nodes.tsx` with these exact variant contracts:

```ts
type UtilityNodeVariant = {
  label: string
  placeholder: string
  defaultSize: { width: number; height: number }
  bounds: {
    minWidth: number
    minHeight: number
    maxWidth: number
    maxHeight: number
  }
  className: string
  textClassName: string
  style: (selected: boolean) => CSSProperties
}

const UTILITY_TEXT_VARIANT: UtilityNodeVariant = {
  label: 'Utility text',
  placeholder: 'Double-click to add text',
  defaultSize: { width: 240, height: 120 },
  bounds: { minWidth: 160, minHeight: 72, maxWidth: 900, maxHeight: 900 },
  className: 'rounded-md',
  textClassName: 'text-foreground placeholder:text-muted-foreground/60',
  style: selected => ({
    background: 'transparent',
    border: selected
      ? '1px dashed rgba(174,195,210,0.75)'
      : '1px solid transparent',
  }),
}

const STICKY_NOTE_VARIANT: UtilityNodeVariant = {
  label: 'Sticky note',
  placeholder: 'Double-click to add a note',
  defaultSize: { width: 240, height: 200 },
  bounds: { minWidth: 180, minHeight: 120, maxWidth: 900, maxHeight: 900 },
  className: 'rounded-sm',
  textClassName: 'text-[#241E0A] placeholder:text-[#241E0A]/60',
  style: selected => ({
    background: '#F5D565',
    border: selected
      ? '2px solid rgba(107,143,168,0.95)'
      : '1px solid rgba(36,30,10,0.28)',
  }),
}
```

The shared component must:

- read text directly from `data.text` so remote updates render without duplicate local draft state;
- use a non-editing overlay for normal dragging;
- enter editing on double-click;
- render a controlled plain `<textarea>`;
- call `patchNodeData(id, { text: event.currentTarget.value })` on input;
- use `nodrag nopan nowheel` while editing;
- blur on Escape and allow Enter to insert a newline;
- set `readOnly` when `persistenceStatus === 'READ_ONLY'`;
- wrap the node with `ResizableNodeFrame`;
- render no React Flow connection handles.

Export memoized implementations:

```ts
export const UtilityTextNode = memo(UtilityTextNodeImpl)
UtilityTextNode.displayName = 'UtilityTextNode'

export const StickyNoteNode = memo(StickyNoteNodeImpl)
StickyNoteNode.displayName = 'StickyNoteNode'
```

- [ ] **Step 4: Run the focused test**

```bash
rtk npx tsx --test lib/canvas-utility-nodes.test.ts
```

- [ ] **Step 5: Run lint**

```bash
rtk npm run lint
```

- [ ] **Step 6: Commit Task 1**

```bash
rtk git add components/canvas/nodes/utility-nodes.tsx lib/canvas-utility-nodes.test.ts
rtk git commit -m "feat(canvas): add utility node components"
```

---

### Task 2: Register Utilities and Preserve Legacy Note Cleanup

**Files:**
- Create: `nexoclip-app/services/spite/lib/canvas-utilities-menu.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/add-node-menu.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-workspace.tsx`
- Modify: `nexoclip-app/services/spite/lib/canvas-dark-rollback.test.ts`
- Modify: `nexoclip-app/services/spite/lib/legacy-notes.test.ts`
- Modify: `nexoclip-app/services/spite/lib/realtime/react-flow-binding.test.ts`

**Interfaces:**
- Produces category `UTILITIES` with node types `utilityText` and `stickyNote`.
- Registers both components in `NODE_TYPES`.
- Relies on generic Yjs node-data persistence; production binding code remains unchanged.

- [ ] **Step 1: Write failing menu and registry tests**

Create `lib/canvas-utilities-menu.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const menu = read('../components/canvas/add-node-menu.tsx')
const workspace = read('../components/canvas/canvas-workspace.tsx')

test('menu separates generator Prompt from canvas utilities', () => {
  assert.match(menu, /label:\s*'Prompt'[\s\S]*category:\s*'BASICS'[\s\S]*nodeType:\s*'prompt'/)
  assert.match(menu, /label:\s*'Text'[\s\S]*category:\s*'UTILITIES'[\s\S]*nodeType:\s*'utilityText'/)
  assert.match(menu, /label:\s*'Sticky Note'[\s\S]*category:\s*'UTILITIES'[\s\S]*nodeType:\s*'stickyNote'/)
  assert.match(menu, /const CATEGORIES = \['BASICS', 'UTILITIES', 'MEDIA', 'MODIFIERS', 'UPSCALER'\]/)
})

test('Utilities contains no Table', () => {
  assert.doesNotMatch(menu, /label:\s*'Table'/)
  assert.doesNotMatch(menu, /nodeType:\s*'table'/)
})

test('workspace registers and labels both utility node types', () => {
  assert.match(workspace, /utilityText:\s*UtilityTextNode/)
  assert.match(workspace, /stickyNote:\s*StickyNoteNode/)
  assert.match(workspace, /utilityText:\s*`Text #\$\{count\}`/)
  assert.match(workspace, /stickyNote:\s*`Sticky Note #\$\{count\}`/)
})
```

- [ ] **Step 2: Tighten legacy-note tests before adding Sticky Note**

In `legacy-notes.test.ts`, add this non-legacy fixture:

```ts
{ id: 'sticky', type: 'stickyNote' }
```

Keep expected legacy deletions unchanged.

In `canvas-dark-rollback.test.ts`, replace any broad `/NoteNode/` check with exact legacy checks:

```ts
assert.doesNotMatch(
  workspace,
  /from ['"]\.\/nodes\/note-node['"]|activeTool === 'note'|^\s*note:\s/m,
)
assert.match(workspace, /stickyNote:\s*StickyNoteNode/)
```

Continue asserting that the removed legacy `nodes/note-node.tsx` file does not exist.

- [ ] **Step 3: Add a generic Yjs convergence characterization**

Add to `lib/realtime/react-flow-binding.test.ts`:

```ts
test('utility node text and dimensions converge through generic node data', () => {
  const local = createCanvasDocument()
  const binding = createReactFlowBinding(local)

  binding.createNode({
    id: 'utility-1',
    type: 'utilityText',
    position: { x: 10, y: 20 },
    data: { sceneId: 'scene-1', text: 'Label', width: 240, height: 120 },
  })
  binding.createNode({
    id: 'sticky-1',
    type: 'stickyNote',
    position: { x: 300, y: 20 },
    data: { sceneId: 'scene-1', text: 'Note', width: 240, height: 200 },
  })

  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
  const remoteBinding = createReactFlowBinding(remote)
  const update = captureUpdate(remote, () => {
    remoteBinding.batch(({ patchNodeData }) => {
      patchNodeData('utility-1', { text: 'Remote label', width: 320, height: 160 })
      patchNodeData('sticky-1', { text: 'Remote note', width: 280, height: 220 })
    })
  })
  Y.applyUpdate(local, update, 'remote-sync')

  const projection = readCanvasProjection(local)
  assert.deepEqual(findNode(projection, 'utility-1').data, {
    sceneId: 'scene-1', text: 'Remote label', width: 320, height: 160,
  })
  assert.deepEqual(findNode(projection, 'sticky-1').data, {
    sceneId: 'scene-1', text: 'Remote note', width: 280, height: 220,
  })

  remoteBinding.destroy()
  binding.destroy()
})
```

- [ ] **Step 4: Run tests and confirm menu/registry RED while Yjs characterization passes**

```bash
rtk npx tsx --test lib/canvas-utilities-menu.test.ts lib/canvas-dark-rollback.test.ts lib/legacy-notes.test.ts
rtk npx tsx --test lib/realtime/react-flow-binding.test.ts
```

- [ ] **Step 5: Add the Utilities category and items**

In `add-node-menu.tsx`:

1. Import `NotePencil` and `Wrench`.
2. Keep the existing Basics item as Prompt.
3. Add:

```ts
{ id: 'utility-text', label: 'Text', shortcut: '', icon: TextT, category: 'UTILITIES', nodeType: 'utilityText' },
{ id: 'sticky-note', label: 'Sticky Note', shortcut: '', icon: NotePencil, category: 'UTILITIES', nodeType: 'stickyNote' },
```

4. Set category order:

```ts
const CATEGORIES = ['BASICS', 'UTILITIES', 'MEDIA', 'MODIFIERS', 'UPSCALER']
```

5. Add `UTILITIES: Wrench` to category icons.

Do not add shortcuts that conflict with Prompt's `T`.

- [ ] **Step 6: Register components and labels**

Import both utility components in `canvas-workspace.tsx`, then extend `NODE_TYPES`:

```ts
utilityText: UtilityTextNode,
stickyNote: StickyNoteNode,
```

Extend `makeNode` label generation:

```ts
utilityText: `Text #${count}`,
stickyNote: `Sticky Note #${count}`,
```

Use the existing menu → `addNode` → `makeNode` → `commands.createNode` path. Do not add a utility-specific API or persistence branch.

- [ ] **Step 7: Run focused tests and lint**

```bash
rtk npx tsx --test lib/canvas-utility-nodes.test.ts lib/canvas-utilities-menu.test.ts lib/canvas-dark-rollback.test.ts lib/legacy-notes.test.ts lib/realtime/react-flow-binding.test.ts
rtk npm run lint
```

- [ ] **Step 8: Commit Task 2**

```bash
rtk git add components/canvas/add-node-menu.tsx components/canvas/canvas-workspace.tsx lib/canvas-utilities-menu.test.ts lib/canvas-dark-rollback.test.ts lib/legacy-notes.test.ts lib/realtime/react-flow-binding.test.ts
rtk git commit -m "feat(canvas): register text and sticky utilities"
```

---

### Task 3: Improve Scoped Canvas Icon Legibility

**Files:**
- Create: `nexoclip-app/services/spite/lib/canvas-icon-legibility.test.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/canvas-toolbar.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/left-toolbar.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/add-node-menu.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/node-toolbar.tsx`

- [ ] **Step 1: Write the failing scoped visual contract test**

Create `lib/canvas-icon-legibility.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const top = read('../components/canvas/canvas-toolbar.tsx')
const left = read('../components/canvas/left-toolbar.tsx')
const addMenu = read('../components/canvas/add-node-menu.tsx')
const nodeActions = read('../components/canvas/nodes/node-toolbar.tsx')

function expectIcon(source: string, icon: string, size: number) {
  assert.match(source, new RegExp(`<${icon} size=\\{${size}\\} weight="regular"`))
}

test('primary top canvas controls use 16px regular glyphs', () => {
  for (const icon of [
    'ArrowLeft', 'MagnifyingGlassPlus', 'MagnifyingGlassMinus',
    'CornersOut', 'ListChecks', 'Question',
  ]) expectIcon(top, icon, 16)
})

test('compact left toolbar uses legible 16px glyphs', () => {
  assert.match(left, /<tool\.icon size=\{16\}/)
  expectIcon(left, 'ClockCounterClockwise', 16)
  expectIcon(left, 'ArrowCounterClockwise', 16)
  expectIcon(left, 'ArrowClockwise', 16)
  assert.match(left, /<cat\.icon size=\{16\} weight="regular"/)
})

test('menu and node-action icons grow without button reflow', () => {
  assert.match(addMenu, /<item\.icon size=\{15\} weight="regular"/)
  assert.match(nodeActions, /<Icon size=\{14\}/)
  assert.match(nodeActions, /w-6 h-6 rounded-full/)
})

test('the pass does not reference global visual tokens', () => {
  for (const source of [top, left, addMenu, nodeActions]) {
    assert.doesNotMatch(source, /globals\.css|--muted-foreground/)
  }
})
```

- [ ] **Step 2: Run and confirm RED**

```bash
rtk npx tsx --test lib/canvas-icon-legibility.test.ts
```

- [ ] **Step 3: Update top and compact-left toolbar icons**

Use 16px regular glyphs for primary top-toolbar controls. In the compact left toolbar use:

```tsx
<tool.icon size={16} weight={activeTool === tool.id ? 'fill' : 'regular'} />
<ClockCounterClockwise size={16} weight="regular" />
<cat.icon size={16} weight="regular" />
<ArrowCounterClockwise size={16} weight="regular" />
<ArrowClockwise size={16} weight="regular" />
```

Leave save-status glyphs and disabled opacity unchanged because they communicate state.

- [ ] **Step 4: Update add-menu and node-action glyphs**

In `add-node-menu.tsx`, use 14px for Search and 15px for category/item icons while keeping existing `w-7 h-7` containers.

In `node-toolbar.tsx`:

- main action icons: 12px → 14px;
- menu icons: 12px → 14px;
- dropdown carets: 8px → 10px;
- nested submenu caret: 10px → 12px;
- keep `w-6 h-6` action buttons and existing dropdown widths;
- do not touch Image/Video/Prompt connection-handle icons.

- [ ] **Step 5: Run focused tests and lint**

```bash
rtk npx tsx --test lib/canvas-icon-legibility.test.ts lib/canvas-utility-nodes.test.ts lib/canvas-utilities-menu.test.ts
rtk npm run lint
```

- [ ] **Step 6: Commit Task 3**

```bash
rtk git add components/canvas/canvas-toolbar.tsx components/canvas/left-toolbar.tsx components/canvas/add-node-menu.tsx components/canvas/nodes/node-toolbar.tsx lib/canvas-icon-legibility.test.ts
rtk git commit -m "style(canvas): improve canvas icon legibility"
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

- [ ] **Step 2: Confirm prohibited files are unchanged**

```bash
rtk git diff HEAD~3 -- package.json pnpm-lock.yaml app/globals.css styles lib/realtime/react-flow-binding.ts
```

Expected: no output.

- [ ] **Step 3: Review scope and secrets**

```bash
rtk git diff --check
rtk git status --short
rtk git diff HEAD~3 -- components/canvas lib
rtk git diff HEAD~3 | rtk grep -n -i "api[_-]key\|secret\|token" || true
```

- [ ] **Step 4: Perform two-tab manual acceptance**

1. Confirm Basics contains Prompt and Utilities contains Text and Sticky Note.
2. Confirm no Table appears.
3. Create Utility Text, drag it, double-click to edit, add newlines, Escape/blur, resize, and reload.
4. Create Sticky Note and confirm fixed high-contrast styling, no picker, and no handles.
5. Confirm `stickyNote` survives legacy-note cleanup and reload.
6. Edit/resize both utilities in one tab and confirm remote convergence in the second.
7. Confirm toolbar glyphs are larger without button reflow.
8. Confirm connection handles and edge anchors did not move.
