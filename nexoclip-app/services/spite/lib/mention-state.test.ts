import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acknowledgePendingMentionState,
  hasPersistedMentionConflict,
  mentionStateKey,
  shouldApplyRemoteMentionState,
  type PersistedMention,
} from './mention-state'

const noMentions: PersistedMention[] = []
const nathan: PersistedMention[] = [{ folderId: 'character-1', name: 'Nathan', selectedAssetIds: ['front', 'side'], selectedWorkspaceAssetIds: ['asset-front', 'asset-side'] }]

test('mention state changes when the chip metadata changes but text stays the same', () => {
  assert.notEqual(
    mentionStateKey('Use @Nathan', noMentions),
    mentionStateKey('Use @Nathan', nathan),
  )
})

test('an editing guest accepts remote chip metadata when its visible text is unchanged', () => {
  assert.equal(shouldApplyRemoteMentionState({
    editing: true,
    localText: 'Use @Nathan',
    localMentions: noMentions,
    incomingText: 'Use @Nathan',
    incomingMentions: nathan,
  }), true)
})

test('selected canonical asset IDs participate in the durable mention state key', () => {
  assert.notEqual(
    mentionStateKey('Use @Nathan', [{ folderId: 'character-1', name: 'Nathan', selectedAssetIds: ['front'] }]),
    mentionStateKey('Use @Nathan', [{ folderId: 'character-1', name: 'Nathan', selectedAssetIds: ['front'], selectedWorkspaceAssetIds: ['asset-front'] }]),
  )
})

test('a pending prompt draft clears only after the exact shared state echoes it', () => {
  const pending = mentionStateKey('Use @Nathan', nathan)
  assert.equal(acknowledgePendingMentionState(pending, mentionStateKey('Use @Nat', noMentions)), pending)
  assert.equal(acknowledgePendingMentionState(pending, pending), null)
})

test('a persisted divergent shared state is treated as a collaboration conflict', () => {
  const pending = mentionStateKey('Use @Nathan', nathan)
  const merged = mentionStateKey('Use @Nathan and @Natasya', nathan)
  assert.equal(hasPersistedMentionConflict(pending, merged, 'PERSISTING'), false)
  assert.equal(hasPersistedMentionConflict(pending, merged, 'PERSISTED'), true)
  assert.equal(hasPersistedMentionConflict(pending, merged, 'SYNCED'), true)
  assert.equal(hasPersistedMentionConflict(pending, pending, 'PERSISTED'), false)
})

test('a stale collaboration echo cannot remove a locally inserted mention chip', () => {
  assert.equal(shouldApplyRemoteMentionState({
    editing: true,
    pendingLocalStateKey: mentionStateKey('Use @Nathan', nathan),
    localText: 'Use @Nathan',
    localMentions: nathan,
    incomingText: 'Use @Nathan',
    incomingMentions: noMentions,
  }), false)
})

test('an editing guest does not clobber divergent local text', () => {
  assert.equal(shouldApplyRemoteMentionState({
    editing: true,
    localText: 'Use @Nat',
    localMentions: noMentions,
    incomingText: 'Use @Nathan',
    incomingMentions: nathan,
  }), false)
})

test('a pending local edit is not clobbered when the editor closes before persistence echoes it', () => {
  assert.equal(shouldApplyRemoteMentionState({
    editing: false,
    pendingLocalStateKey: mentionStateKey('Use @Nathan', nathan),
    localText: 'Use @Nathan',
    localMentions: nathan,
    incomingText: 'Use @Nat',
    incomingMentions: noMentions,
  }), false)
})
