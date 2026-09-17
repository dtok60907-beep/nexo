import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./project-ownership.ts', import.meta.url), 'utf8')

test('legacy generation asset ownership casts UUID project ids to the text foreign key', () => {
  const query = source.slice(
    source.indexOf('export async function findOwnedGenerationAsset'),
    source.indexOf('export async function countOwnedGenerationAssetsForProject'),
  )

  assert.match(query, /JOIN projects p ON p\.id::text = g\.project_id/)
  assert.doesNotMatch(query, /JOIN projects p ON p\.id = g\.project_id/)
})
