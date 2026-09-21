import test from 'node:test'
import assert from 'node:assert/strict'

import {
  captureCaretOffset,
  mentionFoldersStateKey,
  restoreCaretFromOffset,
  shouldPersistRenderedMentionState,
  workspaceAssetIdsForSelection,
} from '../components/canvas/mention-textarea'

test('new mention chips retain canonical workspace asset IDs for the selected legacy items', () => {
  const folder = {
    id: 'folder-1',
    name: 'Nathan',
    type: 'character' as const,
    assets: [
      { id: 'legacy-front', workspaceAssetId: 'asset-front', r2_url: '/front.png', type: 'image' as const },
      { id: 'legacy-side', workspaceAssetId: 'asset-side', r2_url: '/side.png', type: 'image' as const },
      { id: 'legacy-missing', r2_url: '/missing.png', type: 'image' as const },
    ],
  }

  assert.deepEqual(
    workspaceAssetIdsForSelection(folder, new Set(['legacy-front', 'legacy-missing'])),
    ['asset-front'],
  )
})

test('derived canonical chip metadata is persisted even when serialized text is unchanged', () => {
  assert.equal(shouldPersistRenderedMentionState(
    'Use @Nathan',
    [{ folderId: 'folder-1', name: 'Nathan', selectedAssetIds: ['legacy-front'] }],
    'Use @Nathan',
    [{
      folderId: 'folder-1',
      name: 'Nathan',
      selectedAssetIds: ['legacy-front'],
      selectedWorkspaceAssetIds: ['asset-front'],
    }],
  ), true)
})

test('folder state identity changes when canonical asset metadata changes at the same length', () => {
  const folder = {
    id: 'folder-1',
    name: 'Nathan',
    type: 'character' as const,
    assets: [{ id: 'legacy-front', r2_url: '/front.png', type: 'image' as const }],
  }

  assert.notEqual(
    mentionFoldersStateKey([folder]),
    mentionFoldersStateKey([{ ...folder, assets: [{ ...folder.assets[0], workspaceAssetId: 'asset-front' }] }]),
  )
})

let JSDOM: any
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  JSDOM = require('jsdom').JSDOM
} catch (e) {
  JSDOM = null
}

if (!JSDOM) {
  // Can't run DOM-dependent tests in this environment; mark as skipped so
  // CI/test runner output remains clear.
  test.skip('capture and restore collapsed caret across a chip boundary', () => {})
} else {
  // Setup a JSDOM environment for DOM APIs used by the mapping helpers.
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  // @ts-ignore - test runner globals
  global.window = dom.window
  // @ts-ignore
  global.document = dom.window.document
  // @ts-ignore
  global.Node = dom.window.Node

  // Pure mapping tests for caret offset capture/restore. These are best-effort
  // and exercise the serialized offset mapping used during DOM re-renders.

  test('capture and restore collapsed caret across a chip boundary', () => {
  const el = document.createElement('div')
  const before = document.createTextNode('Hello ')
  const chip = document.createElement('span')
  chip.dataset.mention = '1'
  chip.dataset.name = 'Nathan'
  chip.dataset.folderId = 'character-1'
  chip.textContent = 'Nathan'
  const after = document.createTextNode(' world')
  el.appendChild(before)
  el.appendChild(chip)
  el.appendChild(after)

  // Place caret after the 'Hello ' (offset 6)
  const range = document.createRange()
  range.setStart(before, 6)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)

  const offset = captureCaretOffset(el)
  assert.equal(typeof offset, 'number')
  assert.equal(offset, 6)

  // Simulate a DOM re-render that reconstructs the nodes.
  const val = el.textContent || ''
  el.innerHTML = ''
  const b2 = document.createTextNode('Hello ')
  const chip2 = document.createElement('span')
  chip2.dataset.mention = '1'
  chip2.dataset.name = 'Nathan'
  chip2.dataset.folderId = 'character-1'
  chip2.textContent = 'Nathan'
  const a2 = document.createTextNode(' world')
  el.appendChild(b2)
  el.appendChild(chip2)
  el.appendChild(a2)

  // Restore caret
  restoreCaretFromOffset(el, offset!)
  const sel2 = window.getSelection()!
  assert.equal(sel2.rangeCount, 1)
  const r2 = sel2.getRangeAt(0)
  assert.equal(r2.startContainer.nodeType, Node.TEXT_NODE)
  assert.equal(r2.startOffset, 6)
})
}

