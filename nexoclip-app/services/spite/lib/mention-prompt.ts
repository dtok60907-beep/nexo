import type { ModelConfig } from './fal-models'

export type FolderType = 'character' | 'prop' | 'location' | 'general'

interface MentionInput {
  folderId: string
  name: string
  selectedAssetIds: string[]
  selectedWorkspaceAssetIds?: string[]
}

interface FolderInput {
  id: string
  name: string
  type: FolderType
  assets: { id: string; workspaceAssetId?: string; r2_url: string }[]
}

// One logical "subject" worth of reference images. For folder mentions
// this is all the URLs the user picked from one folder; for wired refs
// (video-node's reference-in handle) it's a single URL with no folder
// context. The server consumes groups directly when the target model is
// element-based (Kling v3), and flattens them otherwise.
export interface ReferenceGroup {
  urls: string[]
  workspaceAssetIds: string[]
  folderName?: string
  folderType?: FolderType
}

// How aggressively to rewrite @FolderTag tokens in the prompt:
//   citation-flat     — model expects "@Image{N}" / "@Element{N}" where
//                       N is the slot in a flat URL array (Seedance,
//                       Kling 1.6, Kling o1).
//   citation-elements — model expects "@Element{N}" where N is the
//                       element index in a grouped structure (Kling v3).
//   multi             — model has a multi-image input but no citation
//                       grammar (Nano Banana). Rewrite to plain English.
//   single            — model accepts a single reference image (FLUX
//                       i2i, Kling 1.0/1.5 image-to-video). Only the
//                       first mention gets a slot; the rest fall back
//                       to their folder name as plain text.
//   none              — model has no reference-image support at all.
//                       Tags become readable folder names so the prompt
//                       still makes sense; no URLs are sent.
export type RefStrategy =
  | 'citation-flat'
  | 'citation-elements'
  | 'multi'
  | 'single'
  | 'none'

export interface CompiledMentions {
  prompt: string
  refGroups: ReferenceGroup[]
  strategy: RefStrategy
}

// Must match tagFromName in mention-textarea.tsx — collapses any run of
// non-word chars to a dash so "Elias' Horse" matches "@Elias-Horse".
function tagFromName(name: string): string {
  return name.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')
}

function exactReference(type: FolderType, reference: string): string {
  if (type === 'character') {
    return `the exact same person/character shown in ${reference}, and preserve facial identity, facial structure, skin tone, hairstyle, and distinguishing features without substitution or redesign`
  }
  if (type === 'prop') {
    return `the exact same object shown in ${reference}, and preserve its shape, geometry, materials, colors, markings, and distinguishing details without substitution or redesign`
  }
  if (type === 'location') {
    return `the exact same location shown in ${reference}, and preserve its spatial layout, architecture, landmarks, materials, and distinguishing details without substitution or redesign`
  }
  return `the exact same subject shown in ${reference}, and preserve its identity and distinguishing details without substitution or redesign`
}

export function pickRefStrategy(model: ModelConfig | null | undefined): RefStrategy {
  if (!model) return 'none'
  if (model.referenceCite) {
    return model.referenceParam === 'elements' ? 'citation-elements' : 'citation-flat'
  }
  if (model.referenceParam || model.imageParam === 'image_urls') return 'multi'
  if (model.imageParam === 'image_url') return 'single'
  // Video models without explicit imageParam still accept a single
  // first-frame image via image_url/start_image_url. One folder ref can
  // ride in that slot, so treat as single-ref capable.
  if (model.category === 'video' && model.inputTypes.includes('image') && model.editModel) {
    return 'single'
  }
  return 'none'
}

function collectGroups(
  prompt: string,
  mentions: MentionInput[],
  folders: FolderInput[],
): {
  groupsByFolderId: Map<string, ReferenceGroup>
  orderedFolderIds: string[]
} {
  const groupsByFolderId = new Map<string, ReferenceGroup>()
  const orderedFolderIds: string[] = []
  const seen = new Set<string>()

  const consider = (folder: FolderInput, selectedIds?: string[], selectedWorkspaceIds?: string[]) => {
    if (seen.has(folder.id)) return
    const useAll = !selectedIds || selectedIds.length === 0
    const idSet = new Set(selectedIds || [])
    const workspaceIdSet = new Set(selectedWorkspaceIds || [])
    const selected = folder.assets
      .filter((asset) => (useAll || idSet.has(asset.id) || (asset.workspaceAssetId && workspaceIdSet.has(asset.workspaceAssetId))) && !!asset.workspaceAssetId)
    const urls = selected.map((asset) => `/api/assets/${encodeURIComponent(asset.workspaceAssetId!)}/download`)
    if (urls.length === 0) return
    seen.add(folder.id)
    groupsByFolderId.set(folder.id, {
      urls,
      workspaceAssetIds: selected.map((asset) => asset.workspaceAssetId!),
      folderName: folder.name,
      folderType: folder.type,
    })
    orderedFolderIds.push(folder.id)
  }

  for (const m of mentions) {
    const folder = folders.find((f) => f.id === m.folderId)
    if (folder) consider(folder, m.selectedAssetIds, m.selectedWorkspaceAssetIds)
  }
  const scanRe = /@([\w-]+)/g
  let scanMatch: RegExpExecArray | null
  while ((scanMatch = scanRe.exec(prompt))) {
    const tag = scanMatch[1].toLowerCase()
    const folder = folders.find((f) => tagFromName(f.name).toLowerCase() === tag)
    if (folder) consider(folder)
  }

  return { groupsByFolderId, orderedFolderIds }
}

// `prefixRefCount`: refs that precede folder mentions in the final
// payload — wired pink-handle refs on video-node, or a primary image at
// slot 0 for image_urls-style image models. Used by citation-flat to
// compute correct slot numbers; for citation-elements it counts wired
// element-groups that ride before folder elements.
export function compileMentionsForModel(
  prompt: string,
  mentions: MentionInput[],
  folders: FolderInput[],
  model: ModelConfig | null | undefined,
  prefixRefCount = 0,
): CompiledMentions {
  const strategy = pickRefStrategy(model)
  const { groupsByFolderId, orderedFolderIds } = collectGroups(prompt, mentions, folders)

  // Pre-compute slot starts for citation-flat / multi (slot index = position
  // in the final flat URL array).
  const slotStarts = new Map<string, number>()
  if (strategy === 'citation-flat' || strategy === 'multi') {
    let cursor = prefixRefCount
    for (const fid of orderedFolderIds) {
      slotStarts.set(fid, cursor)
      cursor += groupsByFolderId.get(fid)!.urls.length
    }
  }
  const firstFolderId = orderedFolderIds[0]

  const citationFor = (folderId: string): string => {
    const group = groupsByFolderId.get(folderId)!
    const name = group.folderName || ''
    const type = group.folderType || 'general'

    if (strategy === 'citation-flat') {
      const start = slotStarts.get(folderId)!
      const cite = model!.referenceCite
      const references = Array.from(
        { length: group.urls.length },
        (_, i) => `${cite}${start + i + 1}`,
      ).join(' ')
      return exactReference(type, references)
    }
    if (strategy === 'citation-elements') {
      const i = orderedFolderIds.indexOf(folderId)
      const cite = model!.referenceCite
      return exactReference(type, `${cite}${prefixRefCount + i + 1}`)
    }
    if (strategy === 'multi') {
      const start = slotStarts.get(folderId)!
      const references = group.urls.length > 1
        ? `reference images ${start + 1}-${start + group.urls.length}`
        : `reference image ${start + 1}`
      return exactReference(type, references)
    }
    if (strategy === 'single') {
      if (folderId !== firstFolderId) return name
      return exactReference(type, 'reference image 1')
    }
    return name
  }

  const rewritten = prompt.replace(/@([\w-]+)/g, (match, tag) => {
    const tagLower = (tag as string).toLowerCase()
    const folder = folders.find(
      (f) => tagFromName(f.name).toLowerCase() === tagLower,
    )
    if (!folder) return match
    if (!groupsByFolderId.has(folder.id)) return match
    return citationFor(folder.id)
  })

  let refGroups: ReferenceGroup[] = []
  if (strategy === 'none') {
    refGroups = []
  } else if (strategy === 'single') {
    if (firstFolderId) {
      const first = groupsByFolderId.get(firstFolderId)!
      refGroups = [{ ...first, urls: first.urls.slice(0, 1) }]
    }
  } else {
    refGroups = orderedFolderIds.map((fid) => groupsByFolderId.get(fid)!)
  }

  return { prompt: rewritten, refGroups, strategy }
}
