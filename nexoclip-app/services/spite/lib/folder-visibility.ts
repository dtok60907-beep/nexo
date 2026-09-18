type FolderAsset = { r2_url?: string | null }
type FolderWithAssets = { assets: FolderAsset[] }

export function foldersWithUsableAssets<T extends FolderWithAssets>(folders: T[]): T[] {
  return folders.flatMap((folder) => {
    const assets = folder.assets.filter(
      (asset) => typeof asset.r2_url === 'string' && asset.r2_url.trim().length > 0,
    )
    return assets.length > 0 ? [{ ...folder, assets } as T] : []
  })
}
