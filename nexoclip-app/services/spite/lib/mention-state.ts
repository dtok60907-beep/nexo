export type PersistedMention = {
  folderId: string
  name: string
  selectedAssetIds: string[]
}

export function mentionStateKey(text: string, mentions: PersistedMention[]): string {
  // Normalize selectedAssetIds (dedupe + sort) and sort mentions by
  // folderId so that equivalent semantic states with different ordering
  // don't produce different keys. Do not mutate the original arrays.
  const normalized = mentions
    .map((m) => [
      m.folderId,
      m.name,
      Array.from(new Set(m.selectedAssetIds)).sort(),
    ] as [string, string, string[]])
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
      const aa = a[2].join('\u0000')
      const bb = b[2].join('\u0000')
      if (aa === bb) return 0
      return aa < bb ? -1 : 1
    })
  return JSON.stringify([text, normalized])
}

export function shouldApplyRemoteMentionState({
  editing,
  pendingLocalStateKey,
  localText,
  localMentions,
  incomingText,
  incomingMentions,
}: {
  editing: boolean
  pendingLocalStateKey?: string | null
  localText: string
  localMentions: PersistedMention[]
  incomingText: string
  incomingMentions: PersistedMention[]
}): boolean {
  if (!editing) return true
  if (
    pendingLocalStateKey
    && mentionStateKey(incomingText, incomingMentions) !== pendingLocalStateKey
  ) return false
  if (localText !== incomingText) return false
  return mentionStateKey(localText, localMentions) !== mentionStateKey(incomingText, incomingMentions)
}
