import { withBasePath } from '@/lib/base-path'

export function workspaceAssetDeleteUrl(assetId: string, projectId: string, basePath?: string) {
  return withBasePath(`/api/assets/${encodeURIComponent(assetId)}?projectId=${encodeURIComponent(projectId)}`, basePath)
}
