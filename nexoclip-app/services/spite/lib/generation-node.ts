import { withBasePath } from './base-path'

export function completeGenerationNode(
  data: Record<string, unknown>,
  outputUrl: string,
): Record<string, unknown> {
  const {
    pendingRequestId: _pendingRequestId,
    pendingProvider: _pendingProvider,
    pendingProviderModel: _pendingProviderModel,
    pendingFalEndpoint: _pendingFalEndpoint,
    pendingStartedAt: _pendingStartedAt,
    ...currentData
  } = data

  return {
    ...currentData,
    status: 'completed',
    outputUrl: withBasePath(outputUrl),
    error: null,
  }
}
