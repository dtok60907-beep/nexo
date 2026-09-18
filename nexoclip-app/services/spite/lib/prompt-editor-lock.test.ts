import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimCanvasNodeLock,
  ensureCanvasNodeLocks,
  heartbeatCanvasNodeLock,
  releaseCanvasNodeLock,
} from './prompt-editor-lock'

const input = { projectId: 'project-1', nodeId: 'node-1', participantId: 'tab-1', userId: 'user-1' }

function fakeSql(results: unknown[][]) {
  const queries: string[] = []
  const sql = async (strings: TemplateStringsArray) => {
    queries.push(strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase())
    return results.shift() ?? []
  }
  return { sql: sql as any, queries }
}

test('generic node schema migrates only live prompt leases', async () => {
  const fixture = fakeSql([[], []])
  await ensureCanvasNodeLocks(fixture.sql)
  assert.match(fixture.queries[0], /create table if not exists canvas_node_locks/)
  assert.match(fixture.queries[1], /from canvas_prompt_editor_locks where expires_at > now\(\)/)
})

test('claim uses one project-node authority and permits only expiry or same owner', async () => {
  const fixture = fakeSql([[{ participant_id: 'tab-1', expires_at: 'later' }]])
  const lock = await claimCanvasNodeLock(fixture.sql, input)
  assert.equal(lock.participant_id, 'tab-1')
  assert.match(fixture.queries[0], /on conflict \(project_id, node_id\)/)
  assert.match(fixture.queries[0], /expires_at <= now\(\)/)
  assert.match(fixture.queries[0], /participant_id =/)
  assert.match(fixture.queries[0], /user_id =/)
})

test('non-owner conflict returns no lock', async () => {
  const fixture = fakeSql([[]])
  assert.equal(await claimCanvasNodeLock(fixture.sql, { ...input, participantId: 'tab-2' }), null)
})

test('heartbeat and release are constrained to the current owner', async () => {
  const fixture = fakeSql([[{ participant_id: 'tab-1', expires_at: 'later' }], []])
  assert.ok(await heartbeatCanvasNodeLock(fixture.sql, input))
  await releaseCanvasNodeLock(fixture.sql, input)
  for (const query of fixture.queries) {
    assert.match(query, /project_id =/)
    assert.match(query, /node_id =/)
    assert.match(query, /participant_id =/)
    assert.match(query, /user_id =/)
  }
})
