import type { Sql } from '@/lib/db'

export const NODE_LOCK_LEASE_SECONDS = 15
export const PROMPT_LOCK_LEASE_SECONDS = NODE_LOCK_LEASE_SECONDS

type CanvasNodeLockInput = {
  projectId: string
  nodeId: string
  participantId: string
  userId: string
}

export async function ensureCanvasNodeLocks(sql: Sql): Promise<void> {
  // Keep the historical physical table during rolling deployment. Old Prompt
  // instances and new generic-node instances therefore share one authority.
  await sql`
    CREATE TABLE IF NOT EXISTS canvas_prompt_editor_locks (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id text NOT NULL,
      participant_id text NOT NULL,
      user_id text NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (project_id, node_id)
    )
  `
}

export async function claimCanvasNodeLock(sql: Sql, input: CanvasNodeLockInput) {
  const rows = await sql`
    INSERT INTO canvas_prompt_editor_locks (project_id, node_id, participant_id, user_id, expires_at)
    VALUES (${input.projectId}::uuid, ${input.nodeId}, ${input.participantId}, ${input.userId}, now() + interval '15 seconds')
    ON CONFLICT (project_id, node_id) DO UPDATE
      SET expires_at = now() + interval '15 seconds'
      WHERE canvas_prompt_editor_locks.expires_at <= now()
        OR (canvas_prompt_editor_locks.participant_id = ${input.participantId}
          AND canvas_prompt_editor_locks.user_id = ${input.userId})
    RETURNING participant_id, expires_at
  `
  return rows[0] ?? null
}

export async function heartbeatCanvasNodeLock(sql: Sql, input: CanvasNodeLockInput) {
  const rows = await sql`
    UPDATE canvas_prompt_editor_locks
    SET expires_at = now() + interval '15 seconds'
    WHERE project_id = ${input.projectId}::uuid
      AND node_id = ${input.nodeId}
      AND participant_id = ${input.participantId}
      AND user_id = ${input.userId}
      AND expires_at > now()
    RETURNING participant_id, expires_at
  `
  return rows[0] ?? null
}

export async function releaseCanvasNodeLock(sql: Sql, input: CanvasNodeLockInput): Promise<void> {
  await sql`
    DELETE FROM canvas_prompt_editor_locks
    WHERE project_id = ${input.projectId}::uuid
      AND node_id = ${input.nodeId}
      AND participant_id = ${input.participantId}
      AND user_id = ${input.userId}
  `
}

export const ensurePromptEditorLocks = ensureCanvasNodeLocks
export const claimPromptEditorLock = claimCanvasNodeLock
export const heartbeatPromptEditorLock = heartbeatCanvasNodeLock
export const releasePromptEditorLock = releaseCanvasNodeLock
