# BytePlus Trusted Asset Delete Ordering

## Goal

Prevent a trusted BytePlus asset from being deleted locally while its provider asset remains in BytePlus. Trusted assets must delete from BytePlus first; local cleanup is allowed only after provider deletion succeeds or the provider confirms the asset is already missing.

## Current failure

The Spite asset DELETE route forwards a workspace asset delete to NexoClip. When NexoClip returns `404`, Spite treats the asset as a legacy Spite-only asset and deletes its local generation record/R2 object. For a BytePlus-backed asset whose workspace mapping is missing or whose ID is mismatched, this leaves the BytePlus provider asset orphaned.

## Design

### Trusted asset path

1. Resolve the local workspace asset and its `byteplus_asset_links` row in the unified deletion service.
2. If a provider asset ID exists, call BytePlus `DeleteAsset` with the link's provider asset ID and project name.
3. If BytePlus returns a typed not-found response, treat it as idempotent success.
4. For any other provider error, stop immediately and return the existing retryable `503 BYTEPLUS_ASSET_DELETE_RETRYABLE` error. Do not clean Canvas, storage, mappings, generation outputs, or the local asset.
5. After provider success, clean Canvas references, delete storage, and transactionally remove the provider link, generation outputs, and local asset.

The existing unified service already follows this ordering; tests must lock it down and the route integration must ensure trusted assets cannot bypass it.

### Spite route behavior

1. Attempt the internal unified workspace DELETE first.
2. If it succeeds, return its response unchanged.
3. If it returns a non-404 error, return it unchanged and do not perform legacy cleanup.
4. A `404` may fall back to legacy Spite cleanup only when the Spite asset is not a canonical workspace asset and has no trusted-workspace identity. This preserves legacy behavior without silently deleting a trusted asset.
5. For a canonical workspace asset URL or an asset with a workspace asset ID, propagate the `404` rather than deleting the Spite record. The UI must show an error and leave the local record available for repair/retry.

### UI behavior

The delete action must treat any non-2xx response as a visible failure. It must not remove the asset from local React state unless the DELETE response succeeds. The existing code already keeps state on failure; add a user-facing error/toast if the current component has an established toast mechanism.

## Error handling

- Provider success: continue with local cleanup.
- Provider not found: continue with local cleanup; deletion is idempotent.
- Provider permission, validation, project, network, or server error: return retryable failure and preserve all local state.
- Unified route `404`: preserve canonical/trusted asset; only legacy non-workspace assets may use fallback cleanup.

## Testing

Add/adjust tests for:

1. Provider failure preserves Canvas, storage, link, outputs, and asset.
2. Provider not-found still completes local cleanup.
3. Spite DELETE does not perform legacy cleanup for canonical workspace assets when upstream returns `404`.
4. Spite DELETE still performs legacy cleanup for non-workspace legacy assets when upstream returns `404`.
5. Spite DELETE propagates upstream `503`/`409` and does not perform fallback cleanup.
6. UI keeps the asset visible and reports a failure for non-2xx responses.

## Scope

No provider reconciliation job or manual orphan cleanup is included. Existing orphaned BytePlus assets without a local provider mapping require provider-console cleanup or a separate reconciliation task.
