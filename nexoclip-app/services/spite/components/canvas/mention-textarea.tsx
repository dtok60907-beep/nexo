'use client'

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { X, User, Package, MapPin, Folder, Check, PencilSimple, Trash } from '@phosphor-icons/react'
import { AssetThumb } from './asset-thumb'
import { mentionStateKey } from '@/lib/mention-state'
import { isUsableCaretRect, placeMentionMenu } from '@/lib/mention-position'

export type FolderType = 'character' | 'prop' | 'location' | 'general'

// One folder available for @-mention. Comes straight from /api/folders.
// asset.type was previously `string` — tightened to the actual three
// values the assets API emits so AssetThumb can consume it without a
// cast at every call site.
export interface MentionFolder {
  id: string
  name: string
  type: FolderType
  assets: { id: string; workspaceAssetId?: string; r2_url: string; type: 'image' | 'video' | 'audio' }[]
}

// One inserted mention: a folder + the subset of its assets the user chose.
// We keep the folder name so the @tag rendered into the text can be matched
// back to its folder even if the folder is renamed later (re-resolution by
// id wins; name is the token in the text).
export interface Mention {
  folderId: string
  name: string
  selectedAssetIds: string[]
  selectedWorkspaceAssetIds?: string[]
}

export interface MentionTextareaRef {
  focus: () => void
}

interface Props {
  value: string
  mentions: Mention[]
  onChange: (text: string, mentions: Mention[]) => void
  folders: MentionFolder[]
  placeholder?: string
  className?: string
  disabled?: boolean
  rows?: number
}

const ICONS: Record<FolderType, any> = {
  character: User,
  prop: Package,
  location: MapPin,
  general: Folder,
}

const COLOR: Record<FolderType, string> = {
  character: 'bg-slate-500/20 text-slate-200 border-slate-400/40',
  prop: 'bg-blue-500/20 text-blue-200 border-blue-400/40',
  location: 'bg-green-500/20 text-green-200 border-green-400/40',
  general: 'bg-yellow-500/20 text-yellow-200 border-yellow-400/40',
}

// Folder names can have spaces, apostrophes, accents, etc.; the @tag in
// the prompt text must be limited to chars our regex picker can match
// (\w + dashes). Collapse any run of non-word chars to a single dash and
// trim leading/trailing dashes. "Elias' Horse" → "Elias-Horse".
export function tagFromName(name: string): string {
  return name.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// DOM <-> value serialization
//
// The editor is a contentEditable div. Each mention is rendered as a
// non-editable <span data-mention="1" data-folder-id="..." data-name="..."
// data-asset-ids="csv">. To read the value back out for the parent we walk
// the editor's child nodes, emitting `@FolderName` text for each chip span
// and the literal text for everything else.
// ---------------------------------------------------------------------------

function serializeEditor(el: HTMLElement): { text: string; mentions: Mention[] } {
  let text = ''
  const mentions: Mention[] = []
  const seen = new Set<string>()
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as HTMLElement
      if (e.dataset?.mention === '1') {
        const folderId = e.dataset.folderId || ''
        const name = e.dataset.name || ''
        const assetIds = (e.dataset.assetIds || '').split(',').filter(Boolean)
        const workspaceAssetIds = (e.dataset.workspaceAssetIds || '').split(',').filter(Boolean)
        text += `@${tagFromName(name)}`
        if (folderId && !seen.has(folderId)) {
          seen.add(folderId)
          mentions.push({ folderId, name, selectedAssetIds: assetIds, selectedWorkspaceAssetIds: workspaceAssetIds })
        }
      } else if (e.tagName === 'BR') {
        text += '\n'
      } else {
        text += e.textContent ?? ''
      }
    }
  })
  return { text, mentions }
}

// Read DOM mentions only (without normalised text) — used inside event
// handlers where we only want the current mention IDs.
function listDomMentions(el: HTMLElement): Mention[] {
  return serializeEditor(el).mentions
}

// Build the chip span for a mention. Single text node for the folder
// name — kept atomic so caret/arrow navigation treats the whole chip
// as one unit. Selection counts are shown in the inline popover when
// the user clicks the chip.
function makeChipElement(
  folder: MentionFolder | { id: string; name: string; type: FolderType },
  selectedAssetIds: string[],
  doc: Document,
  selectedWorkspaceAssetIds: string[] = [],
): HTMLSpanElement {
  const span = doc.createElement('span')
  span.dataset.mention = '1'
  span.dataset.folderId = folder.id
  span.dataset.name = folder.name
  span.dataset.type = folder.type
  span.dataset.assetIds = selectedAssetIds.join(',')
  span.dataset.workspaceAssetIds = selectedWorkspaceAssetIds.join(',')
  span.contentEditable = 'false'
  const cls = COLOR[folder.type]
  span.className =
    'mention-chip inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] border align-middle select-none cursor-pointer hover:opacity-90 ' +
    cls
  span.textContent = folder.name
  return span
}

function renderInitial(
  el: HTMLElement,
  value: string,
  mentions: Mention[],
  folders: MentionFolder[],
) {
  // Build segments by scanning `value` for @FolderName tokens. Each token
  // that resolves to a known folder turns into a chip; everything else is
  // plain text. We resolve folders by name (case-insensitive, dashes ←→
  // spaces) so that the parent can hand us a value+mentions snapshot
  // round-tripped from serializeEditor and we'll faithfully reproduce it.
  el.innerHTML = ''
  const re = /@([\w-]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(value))) {
    if (match.index > lastIndex) {
      el.appendChild(document.createTextNode(value.slice(lastIndex, match.index)))
    }
    // Compare on sanitized tag (lowercased), since the on-the-wire @tag
    // collapses spaces/apostrophes/etc. into dashes. "Elias' Horse" and
    // "Elias Horse" both serialize to "Elias-Horse" and must round-trip.
    const tag = match[1].toLowerCase()
    const mentionMatch = mentions.find(
      (m) => tagFromName(m.name).toLowerCase() === tag,
    )
    const folder =
      folders.find((f) => tagFromName(f.name).toLowerCase() === tag) ||
      // Allow rendering a chip for a mention whose folder hasn't been
      // loaded yet — pull the name from the mention list if any matches.
      (mentionMatch
        ? {
            id: mentionMatch.folderId,
            name: mentionMatch.name,
            type: 'general' as FolderType,
          }
        : null)
    if (folder) {
      const m =
        mentions.find((x) => x.folderId === folder.id) ||
        {
          folderId: folder.id,
          name: folder.name,
          selectedAssetIds:
            'assets' in folder ? folder.assets.map((a) => a.id) : [],
        }
      el.appendChild(makeChipElement(folder, m.selectedAssetIds, document, m.selectedWorkspaceAssetIds || ('assets' in folder ? folder.assets.map((asset) => asset.workspaceAssetId).filter((id): id is string => Boolean(id)) : [])))
    } else {
      // Unresolved tag — keep the literal text so the user can fix it.
      el.appendChild(document.createTextNode(match[0]))
    }
    lastIndex = re.lastIndex
  }
  if (lastIndex < value.length) {
    el.appendChild(document.createTextNode(value.slice(lastIndex)))
  }
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

// Find the @query the cursor is currently sitting in, scanning back from
// the caret through the current text node. Returns null if there's a
// space/newline before the next @, or no @ at all.
function findActiveAtQuery(): {
  range: Range
  query: string
  atOffset: number
  textNode: Text
} | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const textNode = node as Text
  const offset = range.startOffset
  const text = textNode.data.slice(0, offset)
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  const between = text.slice(at + 1)
  if (/\s/.test(between)) return null
  return { range, query: between, atOffset: at, textNode }
}

// Place the caret at the end of `node`.
function placeCaretAfter(node: Node) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

// Capture the collapsed caret's offset into the serialized editor string
// (the same format used by serializeEditor) so we can restore it after a
// full DOM re-render. Returns null if there's no collapsed caret inside
// `el` or we can't compute a mapping.
export function captureCaretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null
  const start = range.startContainer
  const startOffset = range.startOffset
  // Ensure the selection is inside the editor
  if (!el.contains(start)) return null

  let offset = 0
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text
      if (node === start) {
        return offset + Math.min(startOffset, t.data.length)
      }
      offset += t.data.length
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as HTMLElement
      if (e.dataset?.mention === '1') {
        // A chip serializes as @<tagFromName(name)>
        const tag = `@${tagFromName(e.dataset.name || '')}`
        const len = tag.length
        // If the caret is inside a text node child of the chip (unlikely
        // since chips are contentEditable=false), consider it as after.
        if (e.contains(start)) return offset + len
        offset += len
      } else if (e.tagName === 'BR') {
        if (node === start) return offset
        offset += 1
      } else {
        const txt = e.textContent || ''
        if (e.contains(start)) {
          // If selection is inside a nested element, try to map to
          // its text nodes by walking its child nodes.
          let innerOffset = 0
          const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, null)
          let cur: Node | null
          while ((cur = walker.nextNode())) {
            if (cur === start) return offset + innerOffset + Math.min(startOffset, (cur as Text).data.length)
            innerOffset += (cur as Text).data.length
          }
          return offset + innerOffset
        }
        offset += txt.length
      }
    }
  }
  // If we fell through, place at end
  return offset
}

// Restore a collapsed caret previously captured with captureCaretOffset.
// Best-effort: if the exact mapping isn't possible we place the caret at
// the closest sensible boundary (after a chip or at end).
export function restoreCaretFromOffset(el: HTMLElement, targetOffset: number) {
  let offset = targetOffset
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text
      if (offset <= t.data.length) {
        const sel = window.getSelection()
        if (!sel) return
        const range = document.createRange()
        range.setStart(t, offset)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      offset -= t.data.length
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as HTMLElement
      if (e.dataset?.mention === '1') {
        const tag = `@${tagFromName(e.dataset.name || '')}`
        const len = tag.length
        if (offset <= len) {
          // Place caret after the chip
          placeCaretAfter(e)
          return
        }
        offset -= len
      } else if (e.tagName === 'BR') {
        if (offset <= 1) {
          placeCaretAfter(e)
          return
        }
        offset -= 1
      } else {
        const txt = e.textContent || ''
        if (offset <= txt.length) {
          // Find the text node to place into
          const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, null)
          let cur: Node | null
          let soFar = 0
          while ((cur = walker.nextNode())) {
            const len = (cur as Text).data.length
            if (offset <= soFar + len) {
              const sel = window.getSelection()
              if (!sel) return
              const range = document.createRange()
              range.setStart(cur as Text, offset - soFar)
              range.collapse(true)
              sel.removeAllRanges()
              sel.addRange(range)
              return
            }
            soFar += len
          }
          // fallback: place after element
          placeCaretAfter(e)
          return
        }
        offset -= txt.length
      }
    }
  }
  // If target beyond end, place caret at end of editor.
  const last = el.lastChild
  if (last) {
    if (last.nodeType === Node.TEXT_NODE) {
      const t = last as Text
      const sel = window.getSelection()
      if (!sel) return
      const range = document.createRange()
      range.setStart(t, t.data.length)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    } else {
      placeCaretAfter(last)
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MentionTextarea = forwardRef<MentionTextareaRef, Props>(function MentionTextarea(
  { value, mentions, onChange, folders, placeholder, className, disabled, rows = 2 },
  outerRef,
) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  // Whether to show the empty-state placeholder text.
  const [showPlaceholder, setShowPlaceholder] = useState(!value)

  // Hover popover state — anchored to a specific chip element.
  const [popover, setPopover] = useState<{
    anchor: HTMLElement
    folderId: string
  } | null>(null)

  useImperativeHandle(outerRef, () => ({
    focus: () => editorRef.current?.focus(),
  }))

  // Initial DOM render. We only re-render the editor from `value`+`mentions`
  // when the parent changes them out-of-band (e.g. loaded from data). Once
  // mounted, the user types and we emit onChange, but we don't sync back
  // from props — that would clobber the caret on every keystroke.
  const lastSerialized = useRef(mentionStateKey('', []))
  const lastFoldersLen = useRef<number>(0)
  const incomingStateKey = mentionStateKey(value, mentions)
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    // Skip only when both text and chip metadata match what this editor
    // emitted. A remote mention selection keeps the same serialized text,
    // so comparing text alone leaves the other guest with a plain @tag.
    const foldersJustResolved = lastFoldersLen.current === 0 && folders.length > 0
    if (incomingStateKey === lastSerialized.current && !foldersJustResolved) return

    // Capture collapsed caret offset (if any) before we replace the DOM so
    // that editing guests don't lose their caret when a remote metadata-only
    // update arrives.
    let capturedOffset: number | null = null
    try {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const range = sel.getRangeAt(0)
        if (el.contains(range.startContainer)) {
          capturedOffset = captureCaretOffset(el)
        }
      }
    } catch (e) {
      capturedOffset = null
    }

    renderInitial(el, value, mentions, folders)
    setShowPlaceholder(el.textContent === '')
    lastSerialized.current = incomingStateKey
    lastFoldersLen.current = folders.length

    // Best-effort restore of a previously-captured caret position.
    if (capturedOffset !== null) {
      try {
        restoreCaretFromOffset(el, capturedOffset)
      } catch (e) {
        // ignore — non-fatal
      }
    }
  }, [incomingStateKey, folders.length])

  // Read the current DOM state and bubble it up.
  const emit = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const { text, mentions } = serializeEditor(el)
    lastSerialized.current = mentionStateKey(text, mentions)
    setShowPlaceholder(el.textContent === '')
    onChange(text, mentions)
  }, [onChange])

  const filteredFolders = (query
    ? folders.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
    : folders
  ).slice(0, 8)

  // Menu positioning: we render the suggestions into a fixed portal and
  // compute its coordinates based on the active query range's
  // getBoundingClientRect(). We remeasure on open, query changes, and
  // on scroll/resize while open.
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null)

  const computePlacement = useCallback(() => {
    if (!open) return
    const el = editorRef.current
    if (!el) return
    let caretRect: DOMRect
    try {
      const q = findActiveAtQuery()
      if (q && q.range) {
        const r = q.range.getBoundingClientRect()
        // A collapsed caret (selection collapsed at an insertion point)
        // often reports width === 0. That is expected — accept zero-width
        // rects as usable (isUsableCaretRect enforces monotonic edges and
        // positive height while allowing width === 0).
        caretRect = isUsableCaretRect(r) ? r : el.getBoundingClientRect()
      } else {
        caretRect = el.getBoundingClientRect()
      }
    } catch (e) {
      caretRect = el.getBoundingClientRect()
    }

    const menuEl = menuRef.current
    const menuSize = menuEl
      ? { width: menuEl.offsetWidth, height: menuEl.offsetHeight }
      : { width: 240, height: 180 }

    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const pos = placeMentionMenu(
      { left: caretRect.left, right: caretRect.right, top: caretRect.top, bottom: caretRect.bottom },
      menuSize,
      viewport,
      8,
    )
    setMenuPos(pos)
  }, [open, query, filteredFolders.length])

  useEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    let raf = 0
    const scheduledRef = { current: false }
    const schedule = () => {
      if (scheduledRef.current) return
      scheduledRef.current = true
      raf = requestAnimationFrame(() => {
        scheduledRef.current = false
        computePlacement()
      })
    }
    raf = requestAnimationFrame(() => computePlacement())
    const onScroll = () => schedule()
    const onResize = () => schedule()
    // Use passive listeners where safe; capture scroll to follow nested scrollables.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, computePlacement])

  // Input handler — detects @query and shows the dropdown, then emits the
  // serialized value.
  const handleInput = () => {
    const q = findActiveAtQuery()
    if (q) {
      setQuery(q.query)
      setOpen(true)
      setHi(0)
    } else {
      setOpen(false)
    }
    emit()
  }

  function insertChipAtCursor(folder: MentionFolder, selected: Set<string>) {
    const q = findActiveAtQuery()
    const el = editorRef.current
    if (!el) return

    if (q) {
      // Replace the @query in the text node with a chip + trailing space.
      const before = q.textNode.data.slice(0, q.atOffset)
      const after = q.textNode.data.slice(q.atOffset + 1 + q.query.length)
      const parent = q.textNode.parentNode
      if (!parent) return
      // Split: text-before | chip | text-after (with leading space if missing)
      const chip = makeChipElement(folder, Array.from(selected), document)
      const afterText = after.startsWith(' ') ? after : ` ${after}`

      parent.insertBefore(document.createTextNode(before), q.textNode)
      parent.insertBefore(chip, q.textNode)
      parent.insertBefore(document.createTextNode(afterText), q.textNode)
      parent.removeChild(q.textNode)

      // Place caret right after the inserted chip's trailing space.
      const inserted = chip.nextSibling
      if (inserted) placeCaretAfter(inserted)
    } else {
      // No @query (user clicked the dropdown without typing) — just append
      // at the end of the editor.
      const chip = makeChipElement(folder, Array.from(selected), document)
      const space = document.createTextNode(' ')
      el.appendChild(chip)
      el.appendChild(space)
      placeCaretAfter(space)
    }

    setOpen(false)
    setQuery('')
    emit()
  }

  function removeChip(folderId: string) {
    const el = editorRef.current
    if (!el) return
    el.querySelectorAll<HTMLElement>(`[data-mention="1"][data-folder-id="${folderId}"]`).forEach((c) => {
      // Also nuke a single leading/trailing space so we don't leave a gap.
      const next = c.nextSibling
      if (next?.nodeType === Node.TEXT_NODE) {
        const t = next as Text
        if (t.data.startsWith(' ')) t.data = t.data.slice(1)
      }
      c.remove()
    })
    setPopover(null)
    emit()
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((i) => (filteredFolders.length ? (i + 1) % filteredFolders.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((i) => (filteredFolders.length ? (i - 1 + filteredFolders.length) % filteredFolders.length : 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const folder = filteredFolders[hi]
      if (folder) {
        e.preventDefault()
        insertChipAtCursor(folder, new Set(folder.assets.map((a) => a.id)))
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // Click handler on the editor — if the user clicked a chip, open its
  // hover popover. (We do this on click instead of true hover so it sticks.)
  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    const chip = target.closest<HTMLElement>('[data-mention="1"]')
    if (chip) {
      e.preventDefault()
      e.stopPropagation()
      setPopover({ anchor: chip, folderId: chip.dataset.folderId || '' })
    } else {
      setPopover(null)
    }
  }

  // Close popover on outside click. (Click on chip is handled above.)
  useEffect(() => {
    if (!popover) return
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement
      if (t.closest('[data-mention-popover]')) return
      if (t.closest('[data-mention="1"]')) return
      setPopover(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [popover])

  // ---------------- Inline asset-picker popover ----------------
  //
  // Clicking a chip opens a small bar anchored to the chip itself, with
  // the folder's asset thumbnails inline. Click any thumb to toggle.
  // Changes apply immediately (no Cancel/Apply — the chip's dataset is
  // mutated in place). Remove button strips the mention entirely.

  function toggleAssetInChip(folderId: string, assetId: string, allAssets: MentionFolder['assets']) {
    const el = editorRef.current
    if (!el) return
    const chip = el.querySelector<HTMLElement>(`[data-mention="1"][data-folder-id="${folderId}"]`)
    if (!chip) return
    const raw = (chip.dataset.assetIds || '').split(',').filter(Boolean)
    // Treat empty dataset.assetIds as "all" so the first toggle deselects
    // an item from the full set instead of jumping from 0/N to 1/N.
    const current = new Set(raw.length === 0 ? allAssets.map((asset) => asset.id) : raw)
    if (current.has(assetId)) current.delete(assetId)
    else current.add(assetId)
    chip.dataset.assetIds = Array.from(current).join(',')
    chip.dataset.workspaceAssetIds = allAssets
      .filter((asset) => current.has(asset.id) && asset.workspaceAssetId)
      .map((asset) => asset.workspaceAssetId!)
      .join(',')
    emit()
    // Force the popover to re-read the chip's dataset so the count updates.
    setPopover((p) => (p ? { ...p } : p))
  }

  const popoverEl = popover && typeof document !== 'undefined'
    ? (() => {
        const folder = folders.find((f) => f.id === popover.folderId)
        if (!folder) return null
        const rawIds = (popover.anchor.dataset.assetIds || '').split(',').filter(Boolean)
        const allIds = folder.assets.map((a) => a.id)
        // Empty selectedAssetIds means "use them all" at resolve time, so
        // reflect that in the UI: every thumb is shown selected.
        const isAll = rawIds.length === 0
        const selectedIds = new Set(isAll ? allIds : rawIds)
        const rect = popover.anchor.getBoundingClientRect()

        // 4 thumbs per row, ~64px each + gap. Anchor below the chip,
        // flipping above if there isn't room. Clamp horizontally to
        // stay on screen.
        const W = 320
        const Hest = folder.assets.length === 0 ? 110 : (Math.ceil(folder.assets.length / 4) * 68) + 110
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8))
        const placeBelow = rect.bottom + Hest + 8 < window.innerHeight
        const top = placeBelow ? rect.bottom + 6 : Math.max(8, rect.top - Hest - 6)

        const Icon = ICONS[folder.type]
        return createPortal(
          <div
            data-mention-popover
            className="fixed z-[70] rounded-lg border border-white/10 bg-[#0E1014] shadow-xl"
            style={{ left, top, width: W }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
              <div className={`w-5 h-5 rounded flex items-center justify-center ${COLOR[folder.type]}`}>
                <Icon size={10} weight="fill" />
              </div>
              <span className="text-[12px] text-foreground/90 truncate flex-1">{folder.name}</span>
              <span className="text-[10px] text-muted-foreground/60">
                {selectedIds.size}/{folder.assets.length}
              </span>
            </div>

            {folder.assets.length === 0 ? (
              <div className="py-6 text-center text-[11px] text-muted-foreground/50">
                Folder is empty — add assets to it first.
              </div>
            ) : (
              <div className="p-2">
                <div className="grid grid-cols-4 gap-1.5 max-h-[260px] overflow-y-auto pr-0.5">
                  {folder.assets.map((asset) => {
                    const needsImport = !asset.workspaceAssetId
                    const isSel = !needsImport && selectedIds.has(asset.id)
                    return (
                      <button
                        type="button"
                        key={asset.id}
                        onClick={() => toggleAssetInChip(folder.id, asset.id, folder.assets)}
                        disabled={needsImport}
                        className={`relative aspect-square rounded-md overflow-hidden border transition ${
                          needsImport ? 'border-amber-400/40 opacity-45 cursor-not-allowed' : isSel ? 'border-accent ring-1 ring-accent/60' : 'border-white/10 hover:border-white/30 opacity-50 hover:opacity-100'
                        }`}
                        title={needsImport ? 'Needs import into Assets before Seedance' : isSel ? 'Click to deselect' : 'Click to select'}
                      >
                        <AssetThumb url={asset.r2_url} type={asset.type} />
                        {needsImport && (
                          <div className="absolute inset-x-0 bottom-0 bg-amber-950/90 px-1 py-0.5 text-[8px] text-amber-200">
                            Needs import
                          </div>
                        )}
                        {isSel && (
                          <div className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-accent flex items-center justify-center">
                            <Check size={9} weight="bold" className="text-white" />
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 px-2 pb-2">
              <button
                type="button"
                onClick={() => removeChip(folder.id)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-red-400 hover:bg-red-500/10"
              >
                <Trash size={10} />
                Remove
              </button>
              <button
                type="button"
                onClick={() => setPopover(null)}
                className="ml-auto px-2 py-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/5"
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )
      })()
    : null

  // (Center-screen picker modal removed — the inline popover now handles
  // asset selection right next to the chip.)

  // ---------------- Render ----------------

  const minH = `${Math.max(1, rows) * 1.4}em`

  return (
    <div className="relative">
      <div className="relative">
        {/* contentEditable surface. */}
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onClick={handleClick}
          onPaste={(e) => {
            // Paste as plain text so users can't smuggle in arbitrary HTML.
            e.preventDefault()
            const t = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, t)
          }}
          className={`${className || ''} whitespace-pre-wrap break-words [&_*]:select-text`}
          style={{ minHeight: minH, outline: 'none' }}
          data-mention-editor
        />
        {/* Empty-state placeholder. The contentEditable div itself can't
            host one natively, so we overlay a span. */}
        {showPlaceholder && (
          <div
            className="absolute inset-0 px-0 py-0 pointer-events-none text-muted-foreground/40 select-none"
            style={{ minHeight: minH }}
          >
            {placeholder}
          </div>
        )}
      </div>

      {/* Folder suggestion dropdown */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 max-h-60 overflow-y-auto rounded-lg border border-white/10 bg-[#0E1014] py-1 shadow-xl min-w-[200px] max-w-[360px]"
          style={{
            left: menuPos ? menuPos.left : -9999,
            top: menuPos ? menuPos.top : -9999,
            visibility: menuPos ? 'visible' : 'hidden',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {filteredFolders.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground/60">
              {folders.length === 0 ? 'No Characters, Props, or Locations yet.' : 'No matching folder.'}
            </div>
          )}
          {filteredFolders.map((f, i) => {
            const Icon = ICONS[f.type]
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => { insertChipAtCursor(f, new Set(f.assets.map((a) => a.id))) }}
                onMouseEnter={() => setHi(i)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left ${i === hi ? 'bg-white/10' : 'hover:bg-white/5'}`}
              >
                <div className={`w-5 h-5 rounded flex items-center justify-center ${COLOR[f.type]}`}>
                  <Icon size={10} weight="fill" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-foreground truncate">{f.name}</div>
                  <div className="text-[9px] text-muted-foreground/50 capitalize">
                    {f.type} · {f.assets.length} asset{f.assets.length !== 1 ? 's' : ''}
                  </div>
                </div>
              </button>
            )
          })}
        </div>,
        document.body,
      )}

      {popoverEl}
    </div>
  )
})

// Resolution + prompt-rewrite for generate time lives in
// `lib/mention-prompt.ts` (compileMentionsForModel). It supersedes the
// old resolveMentionRefs helper that lived here.
