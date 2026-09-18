import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { deleteEmptyAssetFolders } from './project-ownership'

const source = readFileSync(new URL('./project-ownership.ts', import.meta.url), 'utf8')
const folderRoute = readFileSync(new URL('../app/api/folders/[folderId]/route.ts', import.meta.url), 'utf8')

test('legacy generation asset ownership casts UUID project ids to the text foreign key', () => {
  const query = source.slice(
    source.indexOf('export async function findOwnedGenerationAsset'),
    source.indexOf('export async function countOwnedGenerationAssetsForProject'),
  )

  assert.match(query, /JOIN projects p ON p\.id::text = g\.project_id/)
  assert.match(query, /g\.id::text =/)
  assert.doesNotMatch(query, /JOIN projects p ON p\.id = g\.project_id/)
})

test('folder ownership and deletion compare UUID identities safely', () => {
  assert.match(source, /f\.id::text = \$\{folderId\}/)
  assert.match(folderRoute, /DELETE FROM asset_folders WHERE id::text = \$\{folderId\}/)
})

test('deletes only affected folders that have no assets left', async () => {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase()
    assert.match(query, /delete from asset_folders f/)
    assert.match(query, /f\.id::text = any\(\s*\?\s*::text\[\]\)/)
    assert.match(query, /not exists \( select 1 from asset_folder_items i where i\.folder_id = f\.id \)/)
    assert.deepEqual(values[0], ['folder-1', 'folder-2'])
    return [{ id: 'folder-2' }]
  }

  assert.equal(await deleteEmptyAssetFolders(sql as any, ['folder-1', 'folder-2']), 1)
})

test('does not query when no folders were affected', async () => {
  let queried = false
  const sql = async () => {
    queried = true
    return []
  }

  assert.equal(await deleteEmptyAssetFolders(sql as any, []), 0)
  assert.equal(queried, false)
})
