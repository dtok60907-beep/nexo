# BytePlus Stale Trust Re-import Fix

**Date:** 2026-09-18
**Status:** Draft for review

## Goal

Ensure that re-importing an image from Finder creates a new BytePlus asset when the previous BytePlus asset for the same image was deleted, while preserving safe deduplication when the previous provider asset is still valid.

## Problem

Uploading the same image again from Finder does not necessarily create a new local asset. `importWorkspaceAsset()` compares file bytes and can reuse an existing locally trusted asset.

The current trust flow can then reuse a stale `provider_asset_id` without calling BytePlus `GetAsset`. If that provider asset was deleted manually from the BytePlus console, the local mapping still appears `active`, so the UI reports success while no usable asset exists in BytePlus.

The failure is caused by the combination of:

1. byte-exact local deduplication;
2. a stale `byteplus_asset_links` row; and
3. `startTrust()` returning an existing `active` mapping without provider validation.

## Desired Behavior

| Local matching asset | Provider asset state | Expected result |
|---|---|---|
| No matching asset | N/A | Import local asset and create BytePlus asset |
| Matching asset | Exists/active | Reuse local mapping; do not create duplicate provider asset |
| Matching asset | Missing/not found | Invalidate stale mapping, then create a new BytePlus asset |
| Matching asset | Processing | Continue polling the existing trust attempt |
| Matching asset | Failed | Reset trust attempt and create a new provider asset |
| Different project mapping | Any | Mark project mismatch and require explicit re-trust |

## Proposed Design

### 1. Validate active mappings before reuse

Update `createBytePlusAssetTrustService().startTrust()`.

When an existing link has the same project and `status = active` with a provider asset ID:

1. call `provider.getAsset({ assetId: link.provider_asset_id })`;
2. if the provider returns an active/valid asset, return the current trusted state;
3. if the provider reports not found, invalidate the link using compare-and-set;
4. clear the stale `provider_asset_id` and provider group ID as appropriate;
5. create a fresh trust attempt and call `CreateAsset`.

The invalidation must be conditional on the original `attempt_id` and provider asset ID so a concurrent newer trust attempt cannot be overwritten.

### 2. Treat provider not-found as a recoverable stale state

Extend `BytePlusAssetsClient` error classification so a `GetAsset` response indicating the asset does not exist is distinguishable from transient API failures.

Expected handling:

- **Not found:** stale mapping; safe to invalidate and recreate.
- **401/403 or project mismatch:** configuration/ownership error; do not recreate automatically.
- **429/5xx/timeout:** transient provider failure; keep the mapping and return a retryable error.
- **Active:** reuse the existing provider asset.
- **Processing/queued:** keep the mapping and return processing.
- **Failed:** reset and create a new attempt according to existing retry rules.

Provider response details must not be exposed directly to the browser.

### 3. Preserve correct deduplication

Keep byte-exact deduplication for valid trusted assets. A same-content upload must reuse the existing local asset only when its provider mapping is still valid.

`findExactTrustedWorkspaceAsset()` should not return a candidate solely because its local link says `active`. Candidate validation must either:

- validate the provider asset before returning the candidate; or
- allow the trust flow to validate and invalidate the candidate before reuse.

The first implementation should avoid making an external provider call for every normal import if possible. The minimum required validation point is immediately before returning `active` from the trust flow.

### 4. Ensure re-import can recover the same file

After invalidation of a stale mapping, the same file may still resolve to the same local asset row. That is acceptable: the local asset identity can remain stable while its BytePlus provider identity is replaced.

The recreated link must have:

- a new `attempt_id`;
- a new `provider_asset_id` after `CreateAsset`;
- the configured `project_name`;
- `status = processing` until `GetAsset` reports active.

A new local asset row is not required solely because the provider asset was deleted.

### 5. Handle manually deleted assets during generation

If generation receives a BytePlus “asset not found” error for an `asset://` reference:

1. identify the matching local link by `provider_asset_id` and workspace;
2. invalidate it with compare-and-set;
3. prevent the generation request from retrying the same stale ID;
4. return a safe error instructing the user to Trust the asset again.

The next Trust request must follow the recovery path above and create a replacement provider asset.

## Data Changes

No schema migration is required. Existing fields are sufficient:

```text
byteplus_asset_links.workspace_id
byteplus_asset_links.local_asset_id
byteplus_asset_links.provider_asset_id
byteplus_asset_links.group_id
byteplus_asset_links.attempt_id
byteplus_asset_links.project_name
byteplus_asset_links.status
byteplus_asset_links.error
```

Use the existing repository compare-and-set methods or add a narrowly scoped invalidation method. Do not perform an unconditional update by `local_asset_id` alone.

## UI Behavior

The UI must not show “Trusted for Seedance” merely because the local link is marked `active` if provider validation found the asset missing.

After stale invalidation, display:

```text
Trust for Seedance
```

or, while a replacement is being created:

```text
Trusting for Seedance
```

The user should not need to rename or modify the image to recover.

## Testing Plan

Add tests before implementation for:

1. A valid active provider asset is reused without calling `CreateAsset`.
2. An active local mapping whose provider asset is not found is invalidated.
3. After invalidation, the same local image creates a new BytePlus asset.
4. A new trust attempt receives a new `attempt_id` and provider asset ID.
5. A concurrent newer attempt cannot be overwritten by stale invalidation.
6. Provider 429/5xx/timeout keeps the existing mapping and returns a retryable error.
7. Project mismatch does not create a new asset automatically.
8. A provider asset in processing remains processing and is not duplicated.
9. Generation receiving a stale `asset://` ID invalidates the mapping and stops reuse.
10. The UI state changes from active to not trusted/processing after invalidation.
11. Re-importing the same Finder file does not require creating a duplicate local asset when the provider mapping is recoverable.

## Rollout

1. Deploy provider error classification and stale-link validation.
2. Monitor counts of stale mappings invalidated and replacement assets created.
3. Add a read-only report for local `active` links that fail `GetAsset`.
4. Do not bulk-recreate all existing assets automatically; recreate only on validation or explicit Trust.

## Non-Goals

- Removing all duplicate local assets in the workspace.
- Automatically recreating assets for project mismatch or authorization failures.
- Changing BytePlus moderation behavior.
- Changing video generation timeout limits.

## Acceptance Criteria

- Re-importing the same image after its BytePlus asset was deleted results in a new valid BytePlus asset after Trust.
- A valid existing BytePlus asset is still reused and does not create duplicates.
- The UI never reports trusted for a provider asset that no longer exists.
- Stale mappings are invalidated atomically and cannot overwrite newer trust attempts.
- Generation never submits a known-stale `asset://` ID again.
- All transient provider failures remain retryable without local data loss.
