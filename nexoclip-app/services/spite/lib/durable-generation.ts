import type { DurableGeneration } from './nexoclip-generation-client'

const ACTIVE = new Set(['queued', 'running', 'processing'])
const TERMINAL = new Set(['succeeded', 'failed'])

export function createQueuedGenerationPatch(generation: DurableGeneration): Record<string, unknown> {
  return {
    generationId: generation.id,
    generationStatus: generation.status === 'queued' ? 'queued' : 'processing',
    generationError: null,
  }
}

export function createTerminalGenerationPatch(generation: DurableGeneration): Record<string, unknown> | null {
  if (!TERMINAL.has(generation.status)) return null

  if (generation.status === 'succeeded') {
    const outputUrl = generation.outputs?.find((output) => output.download?.url)?.download?.url
    if (outputUrl) {
      return {
        generationStatus: 'completed',
        generationError: null,
        outputUrl,
        status: 'completed',
        error: null,
      }
    }

    return failedPatch('Generation completed without media output.')
  }

  return failedPatch(generation.error?.message || 'Generation failed. Please retry.')
}

export function needsDurableGenerationRecovery(data: Record<string, unknown>): boolean {
  return typeof data.generationId === 'string'
    && typeof data.generationStatus === 'string'
    && ACTIVE.has(data.generationStatus)
}

function failedPatch(message: string): Record<string, unknown> {
  return {
    generationStatus: 'failed',
    generationError: message,
    status: 'failed',
    error: message,
  }
}
