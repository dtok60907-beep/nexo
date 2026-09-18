'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import type { MentionFolder } from '@/components/canvas/mention-textarea'
import { withBasePath } from '@/lib/base-path'
import { foldersWithUsableAssets } from '@/lib/folder-visibility'

const fetcher = async (url: string) => {
  const response = await fetch(withBasePath(url))
  if (!response.ok) throw new Error(`Unable to load mention folders (${response.status})`)
  const data = await response.json()
  return Array.isArray(data) ? (data as MentionFolder[]) : []
}

// SWR-cached folder list for one project. Every node that participates in
// @-mentions (image-gen, video-gen, prompt) calls this; SWR dedupes the
// underlying network request so we never end up with N parallel /api/folders
// calls.
export function useProjectFolders(projectId: string | undefined) {
  const { data, mutate } = useSWR<MentionFolder[]>(
    projectId ? `/api/folders?projectId=${projectId}` : null,
    fetcher,
    { revalidateOnFocus: true, fallbackData: [] },
  )

  // The folder-modal dispatches `folders-changed` after a create/edit/add.
  // The left toolbar already listens to refresh its sidebar; subscribe here
  // too so @-mention suggestion dropdowns inside nodes update immediately.
  useEffect(() => {
    if (!projectId) return
    const handler = () => mutate()
    window.addEventListener('folders-changed', handler)
    return () => window.removeEventListener('folders-changed', handler)
  }, [projectId, mutate])

  return { folders: foldersWithUsableAssets(data || []), refresh: mutate }
}
