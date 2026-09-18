import { NextResponse } from 'next/server'

import { getDb } from '@/lib/db'
import { getAuthenticatedUser } from '@/lib/main-session'
import {
  claimPromptEditorLock,
  ensurePromptEditorLocks,
  heartbeatPromptEditorLock,
  releasePromptEditorLock,
} from '@/lib/prompt-editor-lock'
import { projectNotFoundResponse, unauthorizedResponse, userOwnsProject } from '@/lib/project-ownership'

const NODE_ID = /^[a-zA-Z0-9_-]{1,200}$/
const PARTICIPANT_ID = /^[a-zA-Z0-9_-]{1,200}$/

type Action = 'claim' | 'heartbeat' | 'release'

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse()
    const { projectId } = await params
    const body = await request.json() as { action?: unknown; nodeId?: unknown; participantId?: unknown }
    const action = body.action as Action
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
    const participantId = typeof body.participantId === 'string' ? body.participantId : ''
    if (!['claim', 'heartbeat', 'release'].includes(action) || !NODE_ID.test(nodeId) || !PARTICIPANT_ID.test(participantId)) {
      return NextResponse.json({ error: 'Invalid prompt editor lock request' }, { status: 400 })
    }

    const sql = getDb()
    if (!(await userOwnsProject(sql, user.id, projectId))) return projectNotFoundResponse()
    await ensurePromptEditorLocks(sql)
    const input = { projectId, nodeId, participantId, userId: user.id }

    if (action === 'release') {
      await releasePromptEditorLock(sql, input)
      return NextResponse.json({ locked: false })
    }
    const lock = action === 'claim'
      ? await claimPromptEditorLock(sql, input)
      : await heartbeatPromptEditorLock(sql, input)
    if (!lock) {
      return NextResponse.json({ error: 'This prompt is being edited by another user' }, { status: 409 })
    }
    return NextResponse.json({ locked: true, expiresAt: lock.expires_at })
  } catch (error) {
    console.error('[prompt-editor-lock]', error)
    return NextResponse.json({ error: 'Prompt editor lock unavailable' }, { status: 503 })
  }
}
