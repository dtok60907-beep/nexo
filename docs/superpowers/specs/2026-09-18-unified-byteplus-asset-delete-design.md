# Unified BytePlus Asset Deletion Design

**Date:** 2026-09-18
**Status:** Draft for review

## Goal

Provide one safe delete flow for a workspace asset that keeps BytePlus, NexoClip's database, object storage, and Canvas references consistent.

A delete must remove the asset from:

1. BytePlus Asset Library;
2. NexoClip database mappings and metadata;
3. the backing object in R2/local object storage; and
4. Canvas/workflow references that point to the asset.

## Current Problem

`byteplus_asset_links` stores the provider asset ID, project name, status, and local asset ID, but the existing local asset deletion flow does not call BytePlus `DeleteAsset`. This allows orphaned assets in BytePlus.

The opposite inconsistency also occurs: an asset can be deleted manually in BytePlus while the local mapping remains `active`. A later generation then sends a stale `asset://<provider_asset_id>` and BytePlus rejects it with “asset not found”.

Legacy Spite URLs can also remain in Canvas after an asset is removed from the canonical workspace asset list.

## API Contract

BytePlus API:

```text
POST https://ark.<region>.byteplusapi.com/?Action=DeleteAsset&Version=2024-01-01
```

Request body:

```json
{
  "Id": "<provider_asset_id>",
  "ProjectName": "<project_name>"
}
```

The request uses the existing BytePlus AK/SK HMAC signing implementation. BytePlus deletion is irreversible.

The existing `byteplus_asset_links` row is the match source:

- `workspace_id`
- `local_asset_id`
- `provider_asset_id`
- `project_name`

## Proposed Design

### 1. Extend the BytePlus client

Add `deleteAsset({ assetId, projectName })` to `src/providers/byteplusAssetsClient.js`.

It must:

- require a non-empty asset ID;
- send `Id` and `ProjectName`;
- reuse the existing signed request path and region;
- return the normal API response;
- preserve provider error status/code for the service layer.

### 2. Add a deletion service

Create a service responsible for the cross-system delete flow. It receives `workspaceId` and `localAssetId`, then:

1. starts a DB transaction and locks the local asset row;
2. loads the matching `byteplus_asset_links` row;
3. verifies the link belongs to the configured BytePlus project;
4. commits or releases the DB lock before making the remote BytePlus call;
5. calls `DeleteAsset` when `provider_asset_id` exists;
6. treats a provider “asset not found” response as already deleted;
7. deletes the backing storage object;
8. removes Canvas/workflow references through the existing persistence boundary;
9. deletes local output relations and the asset/link rows in a final transaction.

The final local delete must use all of these predicates when a provider link exists:

```sql
workspace_id = $1
local_asset_id = $2
provider_asset_id = $3
```

This prevents a stale delete request from deleting a newer Trust attempt.

### 3. Failure behavior

- **BytePlus success:** continue with local cleanup.
- **BytePlus asset not found:** treat as idempotent success; continue with local cleanup.
- **BytePlus transient error (timeout, 429, 5xx):** stop before local deletion and return a retryable error. Keep the local asset and mapping intact.
- **Project mismatch:** stop before deletion and return an actionable error. Do not delete local data.
- **Storage delete failure:** do not silently report success. Keep a recoverable local state or return failure according to the existing storage error contract.
- **Canvas cleanup failure:** do not remove the DB asset while references remain unresolved. The operation must be retryable and idempotent.

No distributed transaction is possible across BytePlus, storage, and PostgreSQL. The service must therefore make every step idempotent and record enough identity to retry safely.

### 4. Canvas reference cleanup

Before removing local metadata, find and remove references to the asset from persisted Canvas/workflow data. Supported references include:

- canonical `/api/assets/<assetId>/download` URLs;
- persisted canonical asset IDs;
- legacy `/spite/api/r2-image/...` references when they resolve to the deleted local asset.

The cleanup must not delete unrelated nodes or assets. If a legacy URL cannot be deterministically mapped to the local asset, leave it unchanged and report the cleanup as incomplete rather than deleting unrelated data.

### 5. API route

Add or update the asset delete route to call the deletion service. The route must:

- require an authenticated tenant/workspace;
- accept only the requested asset ID;
- return `404` when the asset does not belong to the workspace;
- return `204` or a success JSON response after complete cleanup;
- expose safe, non-secret error codes for retryable provider/storage failures;
- never expose AK/SK, signed request details, or raw provider response bodies.

### 6. Stale provider mapping recovery

Generation must not blindly trust a local `active` mapping forever. When BytePlus returns “asset not found” for an `asset://` reference:

1. mark the matching local link as `failed` or `not_trusted` using compare-and-set on `attempt_id` and `provider_asset_id`;
2. prevent the generation request from continuing;
3. return an actionable “Trust this asset again” error.

The Trust status endpoint should also translate a provider not-found response into the same invalid/stale state rather than leaving the link `active`.

## Data Model

No schema change is required for the first implementation. Existing fields are sufficient:

```text
byteplus_asset_links.provider_asset_id
byteplus_asset_links.project_name
byteplus_asset_links.status
byteplus_asset_links.attempt_id
assets.storage_key
```

If Canvas references are stored in a separate table, use its existing foreign key/cascade mechanism. If references are embedded in JSON, add a narrowly scoped repository operation for reference removal rather than broad string replacement.

## Testing Plan

Add tests before implementation for:

1. BytePlus client sends `DeleteAsset` with ID and project name.
2. Successful delete removes BytePlus mapping, asset metadata, storage object, and Canvas reference.
3. A provider “not found” response is idempotent and still completes local cleanup.
4. A provider 429/5xx leaves local asset and mapping intact.
5. Project mismatch does not delete anything.
6. Compare-and-set prevents an old delete request from removing a newer Trust mapping.
7. Canonical Canvas references are removed without affecting unrelated references.
8. Legacy references are removed only when their local asset identity is unambiguous.
9. A stale provider asset encountered during generation becomes failed/not-trusted and is not submitted again.
10. The delete route enforces workspace ownership and returns safe errors.

Use mocked provider/storage boundaries only where the external system is unavoidable; assert real service behavior and database query conditions.

## Rollout and Recovery

1. Deploy the client and service behind the existing authenticated asset-delete route.
2. Do not bulk-delete existing BytePlus assets automatically.
3. Add a read-only reconciliation report listing local links whose provider asset is missing or whose project differs.
4. After verification, optionally run a user-approved cleanup for orphaned provider assets.
5. Monitor delete success, idempotent-not-found, project mismatch, and retryable failure counts.

## Non-Goals

- Deleting an entire BytePlus asset group as part of individual asset deletion.
- Automatically deleting assets from BytePlus based only on filename.
- Silently deleting Canvas nodes whose asset ownership cannot be proven.
- Changing video generation timeout behavior; that is a separate change.

## Acceptance Criteria

- Deleting an asset from NexoClip removes the corresponding BytePlus asset when it exists.
- Repeating the delete is safe and does not fail because BytePlus already removed the asset.
- Local DB metadata, mapping, storage object, and known Canvas references are removed together.
- A transient provider failure does not cause irreversible local data loss.
- A stale BytePlus mapping cannot be used for a new generation without being detected and invalidated.
- Tests cover the success, idempotent, mismatch, transient failure, and stale-reference paths.
