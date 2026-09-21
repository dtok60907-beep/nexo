# Independent Upload Asset Identity and Strict Seedance Trust Resolution

**Date:** 2026-09-21  
**Status:** Draft for review

## Goal

Ensure every user upload is an independent NexoClip asset and every Seedance generation uses only the BytePlus asset mapping belonging to that exact `workspaceAssetId`.

Uploading the same bytes, filename, dimensions, or visually identical image must never silently reuse another asset's identity or Trust mapping.

## Current Problems

Two different behaviors currently violate the intended identity model:

1. Some import paths deduplicate an upload by comparing exact file bytes against an existing trusted asset.
2. Direct BytePlus/Seedance video resolution falls back from a missing mapping to `findExactTrustedWorkspaceAsset()`, which can find another trusted asset with identical bytes and reuse its `provider_asset_id`.

This means a newly uploaded asset can generate successfully even though that specific asset was never trusted. It also makes the `workspaceAssetId` non-authoritative and can cause duplicate uploads to share provider identity unexpectedly.

## Product Rules

### Independent upload identity

Every upload/import operation creates a new asset row and a new UUID:

```text
Upload A → workspaceAssetId A → independent Trust state
Upload B → workspaceAssetId B → independent Trust state
```

This remains true when A and B have the same:

- file bytes;
- filename;
- file size;
- dimensions;
- visual content.

No filename, size, byte hash, or visual comparison may cause the second upload to reuse the first asset row.

### Independent Trust

Each `workspaceAssetId` has its own BytePlus Trust lifecycle:

- a new upload starts as `not_trusted`;
- Trust is an explicit user action;
- Trust creates or updates the mapping for that exact local asset ID;
- a different duplicate upload must be trusted separately;
- duplicate BytePlus provider assets are allowed;
- deleting one duplicate must not delete another duplicate.

### Strict Seedance resolution

For direct BytePlus/Seedance generation:

```text
workspaceAssetId without its own active mapping
→ BYTEPLUS_REFERENCE_NOT_TRUSTED
```

The resolver must never:

- match by exact bytes;
- match by filename or size;
- reuse a provider asset from another local asset;
- reuse Trust from a duplicate upload;
- fall back to a raw URL, base64 value, or legacy URL.

The exact `workspaceAssetId` is authoritative.

## Proposed Design

### 1. Remove import deduplication

Update `importWorkspaceAsset()` so every valid import creates a new `assets` row and storage key.

The import path must not call `findExactTrustedWorkspaceAsset()` to return an existing asset. That helper may remain available for narrowly scoped legacy reconciliation or non-Seedance workflows only if its caller explicitly opts into content matching.

The import response must return the newly created asset and its new canonical download URL.

### 2. Make strict mapping resolution the only Seedance path

In `createSaasVideoHandler()` and related direct BytePlus/Seedance resolution:

- resolve each canonical `/api/assets/<workspaceAssetId>/download` reference to that exact local asset ID;
- load `byteplus_asset_links` using workspace and local asset ID;
- require `status = 'active'` and a non-empty `provider_asset_id`;
- resolve to `asset://<that provider_asset_id>`;
- fail with `BYTEPLUS_REFERENCE_NOT_TRUSTED` if the mapping is absent, failed, processing, stale, or missing its provider ID.

Remove or bypass the current content fallback through `findExactTrustedWorkspaceAsset()` for direct BytePlus/Seedance requests.

The fallback must not be used for:

- `referenceImages`;
- `frameImages`;
- `referenceVideos`;
- any other Seedance reference slot.

### 3. Preserve non-Seedance behavior explicitly

Do not silently apply the strict BytePlus rule to unrelated providers. Provider-specific behavior must be explicit:

- direct BytePlus/Seedance: exact local mapping required;
- other providers: retain their existing reference contract;
- legacy references: remain subject to ownership and import checks;
- ambiguous legacy references: fail safely with `Needs import`.

Any content-based reconciliation retained for migration must be a separate, read-only or explicit-import operation and must not run during generation.

### 4. Provider asset creation

Trusting duplicate local uploads may create duplicate BytePlus assets. This is allowed and expected.

Provider idempotency tokens must remain scoped to the exact workspace asset and Trust attempt so two local asset IDs cannot accidentally share an asset-creation token:

```text
workspace_id + local_asset_id + operation + attempt_id
```

A Trust mapping must retain the provider asset ID associated with its own local asset ID.

### 5. Deletion behavior

Deleting local asset A must only target:

- A's own `provider_asset_id`;
- A's own storage object;
- A's own database metadata;
- A's own Canvas/folder references.

It must not identify or delete duplicate asset B by filename, bytes, or provider group membership.

## Error Handling

- Missing mapping: `BYTEPLUS_REFERENCE_NOT_TRUSTED`, HTTP 422.
- Mapping status `processing`: actionable Trust-processing error, HTTP 409 or existing equivalent.
- Mapping status `failed`: actionable retry-Trust error, HTTP 422.
- Active mapping with missing provider ID: invalid Trust state, HTTP 422.
- Provider asset not found: mark only the exact mapping stale using CAS and require Trust again.
- Raw or legacy reference sent to direct Seedance: reject before provider submission.
- No provider request may be made when any Seedance reference fails strict resolution.

Errors must not reveal provider credentials or raw signed requests.

## Data Model

No new schema is required for the core behavior. Existing identity fields remain authoritative:

```text
assets.id                         → workspaceAssetId
byteplus_asset_links.local_asset_id
byteplus_asset_links.provider_asset_id
byteplus_asset_links.status
byteplus_asset_links.attempt_id
```

An optional future `content_hash` may support diagnostics or explicit user-requested reconciliation, but it must not become an implicit identity or Trust lookup key.

## Testing Plan

Add or update tests for:

1. Two imports with identical bytes create two different asset IDs.
2. Two imports with identical filenames create two different asset IDs.
3. A duplicate upload starts untrusted even when the first upload is active.
4. Trusting asset A does not create or activate a mapping for asset B.
5. Seedance resolves an active mapping for the exact local asset ID.
6. Seedance rejects an asset with no mapping even when an identical trusted asset exists.
7. Seedance rejects a mapping with `failed`, `processing`, null provider ID, or stale project.
8. No provider request is made when any one reference fails strict resolution.
9. Multiple duplicate provider assets can coexist safely.
10. Deleting duplicate A leaves duplicate B's mapping and provider asset untouched.
11. Legacy references do not get silently associated by filename, size, or bytes.
12. Existing non-Seedance provider flows retain their documented behavior.

Tests must assert the actual provider payload for successful Seedance requests contains only:

```text
asset://<provider_asset_id belonging to the exact workspaceAssetId>
```

## Migration and Rollout

1. Deploy the strict resolver and import behavior behind the existing Trust flow.
2. Do not bulk-rewrite existing Canvas/folder references.
3. Do not automatically Trust existing assets.
4. Keep existing mappings unchanged during deployment.
5. Report legacy or untrusted references as actionable `Needs import` or `Trust for Seedance` states.
6. Monitor rejected references and duplicate upload behavior.
7. Reconcile old content matches only through an explicit, separately approved tool.

## Non-Goals

- Automatically deleting duplicate provider assets.
- Automatically replacing old Canvas/folder references with a newly uploaded duplicate.
- Treating a content hash as a cross-upload identity.
- Matching assets by filename, size, or visual similarity.
- Bulk Trust creation.
- Changing BytePlus group/project ownership in this task.
- Changing provider behavior for unrelated generation models.

## Acceptance Criteria

- Every upload receives a new `workspaceAssetId`.
- Identical files uploaded twice remain two independent assets.
- Each duplicate requires its own explicit Trust action.
- A Seedance generation cannot use a provider asset belonging to another local asset.
- A missing exact mapping fails locally before BytePlus submission.
- Successful Seedance payloads contain only the exact asset mapping's `asset://` reference.
- Deleting one duplicate never deletes another duplicate's provider asset, storage, or references.
- Existing legacy and non-Seedance behavior remains unchanged unless explicitly covered above.
