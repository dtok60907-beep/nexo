import { withBasePath } from '@/lib/base-path'
import type { CanvasProjection } from '@/lib/realtime/document'

export function workspaceAssetDeleteUrl(assetId: string, projectId: string, basePath?: string) {
  return withBasePath(`/api/assets/${encodeURIComponent(assetId)}?projectId=${encodeURIComponent(projectId)}`, basePath)
}

function isCanonicalAssetUrl(value: unknown, assetId: string) {
  if (typeof value !== 'string') return false
  try {
    return new URL(value, 'https://canvas.invalid').pathname === `/api/assets/${encodeURIComponent(assetId)}/download`
  } catch {
    return false
  }
}

function removeMentionIdentity(value: unknown, assetId: string) {
  if (!Array.isArray(value)) return value
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const mention = item as Record<string, unknown>
    if (!Array.isArray(mention.selectedWorkspaceAssetIds)) return item
    return {
      ...mention,
      selectedWorkspaceAssetIds: mention.selectedWorkspaceAssetIds.filter(id => id !== assetId),
    }
  })
}

export function workspaceAssetReferencePatches(projection: CanvasProjection, assetId: string) {
  return projection.nodes.flatMap(node => {
    const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data)
      ? node.data as Record<string, unknown>
      : {}
    const identityMatches = data.workspaceAssetId === assetId || data.assetId === assetId
    const unset = ['workspaceAssetId', 'assetId']
      .filter(key => data[key] === assetId)
      .concat(['outputUrl', 'thumbnail', 'url'].filter(key =>
        identityMatches ? data[key] !== undefined : isCanonicalAssetUrl(data[key], assetId),
      ))
    const mentions = removeMentionIdentity(data.mentions, assetId)
    const mentionsChanged = JSON.stringify(mentions) !== JSON.stringify(data.mentions)
    if (unset.length === 0 && !mentionsChanged) return []
    return [{ nodeId: node.id, set: mentionsChanged ? { mentions } : {}, unset }]
  })
}
