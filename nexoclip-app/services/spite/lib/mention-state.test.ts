import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mentionStateKey,
  shouldApplyRemoteMentionState,
} from './mention-state'

const noMentions = []
const nathan = [{ folderId: 'character-1', name: 'Nathan', selectedAssetIds: ['front', 'side'] }]

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
