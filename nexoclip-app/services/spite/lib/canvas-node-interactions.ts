import type { Edge, Node } from '@xyflow/react'

type NodeSize = { width: number; height: number }
type NodeSizeBounds = {
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
}
type FollowPeer = {
  cursor?: { x: number; y: number }
  selection?: { nodeIds?: string[] }
  sceneId?: string
}

export function resolveIncomingPrompt(nodeId: string, nodes: Node[], edges: Edge[]) {
  const edge = edges
    .filter((edge) => edge.target === nodeId && edge.targetHandle === 'prompt-in')
    .sort((left, right) => left.id.localeCompare(right.id))[0]
  const source = edge && nodes.find((node) => node.id === edge.source && node.type === 'prompt')

  return { connected: Boolean(source), prompt: String(source?.data.text ?? '').trim() }
}

export function getGenerationPromptState(nodeId: string, nodes: Node[], edges: Edge[]) {
  const { connected, prompt } = resolveIncomingPrompt(nodeId, nodes, edges)
  return {
    connected,
    prompt,
    disabled: !connected || !prompt,
    message: !connected ? 'Connect a Text node first' : !prompt ? 'Enter text in the connected Text node' : undefined,
  }
}

type GenerationStatusQuery = {
  nodeId: string
  generationId: string
  projectId: string
}

export function createGenerationStatusQuery({ nodeId, generationId, projectId }: GenerationStatusQuery) {
  return new URLSearchParams({ projectId, nodeId, generationId })
}

export function parseAspectRatio(value: string, fallback: string): number {
  return parseRatio(value) ?? parseRatio(fallback) ?? 1
}

export function clampNodeSize(size: NodeSize, bounds: NodeSizeBounds): NodeSize {
  return {
    width: clamp(size.width, bounds.minWidth, bounds.maxWidth),
    height: clamp(size.height, bounds.minHeight, bounds.maxHeight),
  }
}

export function resolveFollowTarget(
  peer: FollowPeer,
  nodes: Node[],
): { sceneId?: string; point?: { x: number; y: number } } {
  const peerSceneId = typeof peer.sceneId === 'string' && peer.sceneId.length > 0
    ? peer.sceneId
    : undefined
  const node = peer.selection?.nodeIds
    ?.map((nodeId) => nodes.find((node) => node.id === nodeId))
    .find((node): node is Node => node !== undefined && (!peerSceneId || node.data.sceneId === peerSceneId))
  const sceneId = peerSceneId ?? (typeof node?.data.sceneId === 'string' ? node.data.sceneId : undefined)
  const point = peer.cursor ?? (node ? node.position : undefined)

  return { ...(sceneId ? { sceneId } : {}), ...(point ? { point } : {}) }
}

function parseRatio(value: string): number | undefined {
  const [width, height, ...rest] = value.trim().split(':')
  if (rest.length > 0 || !width || !height) return undefined

  const ratio = Number(width) / Number(height)
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
