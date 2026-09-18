# Unified BytePlus Asset Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete a workspace asset safely and idempotently across BytePlus, Canvas references, object storage, and PostgreSQL while invalidating stale provider mappings and keeping Canvas audio enabled by default.

**Architecture:** Extend the signed BytePlus Assets client with typed provider errors and `DeleteAsset`. A coordinator snapshots the asset and Trust mapping, performs remote cleanup outside database transactions, invokes an authenticated Spite cleanup boundary, then deletes local rows with compare-and-set predicates. Generation and Trust status share stale-provider invalidation logic.

**Tech Stack:** Node.js, Next.js route handlers, PostgreSQL/Neon, BytePlus HMAC API, Yjs realtime Canvas, `node:test`, TypeScript.

## Global Constraints

- Never expose BytePlus AK/SK, signing details, or raw provider error bodies.
- Never hold a PostgreSQL transaction open during BytePlus, storage, or Canvas network calls.
- A transient provider, storage, or Canvas cleanup failure must preserve retryable local metadata.
- Provider-link deletion must match `workspace_id`, `local_asset_id`, and the snapshotted `provider_asset_id`.
- Ambiguous legacy Canvas references remain untouched and make cleanup incomplete.
- Sound controls are hidden; missing/new Canvas media sound state is enabled.
- No bulk deletion or filename-based identity matching.

---

### Task 1: BytePlus DeleteAsset and typed not-found errors

**Files:**
- Modify: `nexoclip-app/src/providers/byteplusAssetsClient.js`
- Test: `nexoclip-app/tests/providers/byteplusAssetsClient.test.mjs`

**Interfaces:**
- Produces: `client.deleteAsset({ assetId, projectName })`
- Produces: `isBytePlusAssetNotFound(error)`

- [ ] **Step 1: Write failing tests** asserting `Action=DeleteAsset`, `Version=2024-01-01`, body `{ Id, ProjectName }`, blank-ID rejection, provider not-found classification, and retryable 429/5xx preservation.
- [ ] **Step 2: Run** `node --test tests/providers/byteplusAssetsClient.test.mjs`; expect new tests to fail.
- [ ] **Step 3: Implement minimal client support** by routing through the existing signed request function and retaining only safe provider `code`, HTTP `status`, and `retryable` fields on `BytePlusAssetsError`.
- [ ] **Step 4: Run the test file** and confirm zero failures.
- [ ] **Step 5: Commit** `feat(byteplus): support trusted asset deletion`.

### Task 2: Compare-and-set repository deletion

**Files:**
- Modify: `nexoclip-app/src/repositories/byteplusAssetRepository.js`
- Test: `nexoclip-app/tests/assets/byteplusAssetRepository.test.mjs`

**Interfaces:**
- Produces: `deleteBytePlusAssetLink(client, { workspaceId, localAssetId, providerAssetId })`
- Produces: `markBytePlusAssetLinkStale(client, { workspaceId, localAssetId, providerAssetId, attemptId, errorCode })`

- [ ] **Step 1: Write failing query tests** requiring every delete predicate and stale-status CAS on provider ID plus attempt ID.
- [ ] **Step 2: Run** `node --test tests/assets/byteplusAssetRepository.test.mjs`; expect failures.
- [ ] **Step 3: Implement narrowly scoped SQL operations** returning whether a row changed.
- [ ] **Step 4: Run tests** and confirm zero failures.
- [ ] **Step 5: Commit** `feat(assets): add trusted mapping delete guards`.

### Task 3: Authoritative Canvas reference cleanup

**Files:**
- Modify: `nexoclip-app/services/spite/lib/realtime/internal-client.ts`
- Modify: `nexoclip-app/services/spite/realtime/server.ts`
- Modify: `nexoclip-app/services/spite/app/api/assets/[assetId]/route.ts`
- Test: `nexoclip-app/services/spite/lib/task-17-server-writers.test.ts`
- Test: `nexoclip-app/services/spite/lib/workspace-asset-delete.test.ts`

**Interfaces:**
- Produces: `cleanupWorkspaceAssetReferences({ projectId, workspaceAssetId, canonicalUrl, legacyUrl })`
- Returns: `{ complete: boolean, changedNodeIds: string[], ambiguousLegacyReferences: string[] }`

- [ ] **Step 1: Write failing tests** for canonical ID/URL removal, unrelated reference preservation, exact legacy URL cleanup, and ambiguous legacy refusal.
- [ ] **Step 2: Run focused Spite tests** using `tsx --test`; expect failures.
- [ ] **Step 3: Add one internal authenticated cleanup operation** that mutates only matching Yjs node-data fields/mention selections and persists through the existing realtime document boundary.
- [ ] **Step 4: Change the Spite asset route** from “keep while referenced” to “clean deterministically or return retryable incomplete cleanup”. Do not forward raw upstream bodies.
- [ ] **Step 5: Run focused tests** and confirm zero failures.
- [ ] **Step 6: Commit** `feat(canvas): clean deleted asset references`.

### Task 4: Cross-system deletion coordinator

**Files:**
- Create: `nexoclip-app/src/services/unifiedAssetDeletionService.js`
- Modify: `nexoclip-app/src/services/assetService.js`
- Test: `nexoclip-app/tests/assets/unifiedAssetDeletionService.test.mjs`
- Test: `nexoclip-app/tests/assets/assetService.test.mjs`

**Interfaces:**
- Produces: `deleteTrustedWorkspaceAsset({ workspaceId, localAssetId, storage, pool, bytePlusClient, cleanupCanvasReferences, configuredProjectName })`
- Returns: `{ deleted: boolean, providerAlreadyMissing: boolean }`

- [ ] **Step 1: Write failing tests** for success, no-link deletion, provider not-found idempotency, transient provider failure, project mismatch, storage failure, Canvas failure, repeated delete, and a newer Trust mapping race.
- [ ] **Step 2: Run focused service tests** and verify they fail for missing coordinator behavior.
- [ ] **Step 3: Implement snapshot transaction** using `SELECT ... FOR UPDATE`, load asset/link identity, then commit before network/storage calls.
- [ ] **Step 4: Implement ordered cleanup**: BytePlus delete, storage delete, Canvas cleanup, then final transaction deleting outputs/link/asset. The final link/asset mutation must fail safely if the provider identity changed.
- [ ] **Step 5: Run service tests** and confirm zero failures.
- [ ] **Step 6: Commit** `feat(assets): coordinate trusted asset deletion`.

### Task 5: Authenticated route integration and safe errors

**Files:**
- Modify: `nexoclip-app/app/api/assets/[assetId]/route.js`
- Modify: `nexoclip-app/services/spite/app/api/assets/[assetId]/route.ts`
- Test: `nexoclip-app/tests/assets/assetDeleteRoute.test.mjs`
- Test: `nexoclip-app/services/spite/lib/workspace-asset-delete.test.ts`

**Interfaces:**
- Main DELETE returns `204` on complete cleanup, `404` on workspace mismatch, and safe JSON error codes on retryable failures.

- [ ] **Step 1: Write failing route tests** for ownership, successful cleanup, retryable provider/storage/Canvas errors, and secret/raw-body redaction.
- [ ] **Step 2: Run route tests** and verify failures.
- [ ] **Step 3: Wire the coordinator** using authenticated tenant workspace and server-owned configuration only.
- [ ] **Step 4: Map typed errors** to stable codes: `BYTEPLUS_ASSET_DELETE_RETRYABLE`, `BYTEPLUS_PROJECT_MISMATCH`, `ASSET_STORAGE_DELETE_FAILED`, and `CANVAS_REFERENCE_CLEANUP_INCOMPLETE`.
- [ ] **Step 5: Run tests** and confirm zero failures.
- [ ] **Step 6: Commit** `fix(assets): unify workspace asset deletion`.

### Task 6: Stale provider mapping invalidation

**Files:**
- Modify: `nexoclip-app/src/services/saasVideoGeneration.js`
- Modify: `nexoclip-app/src/services/byteplusAssetTrustService.js`
- Test: `nexoclip-app/tests/generations/saasVideoGeneration.test.mjs`
- Test: `nexoclip-app/tests/assets/byteplusAssetTrustService.test.mjs`

**Interfaces:**
- Produces safe error code `BYTEPLUS_ASSET_STALE`; user message instructs “Trust this asset again”.

- [ ] **Step 1: Write failing tests** proving provider not-found invalidates only the matching attempt/provider mapping and stops generation; newer mapping remains active.
- [ ] **Step 2: Run both focused test files** and verify failures.
- [ ] **Step 3: Catch classified not-found errors** in Trust polling and generation provider boundaries, CAS the link to failed, and throw the safe actionable error.
- [ ] **Step 4: Run tests** and confirm zero failures.
- [ ] **Step 5: Commit** `fix(byteplus): invalidate stale trusted mappings`.

### Task 7: Hide Canvas sound control and default sound on

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/video-node.tsx`
- Test: `nexoclip-app/services/spite/lib/canvas-node-interactions.test.ts`
- Test: `nexoclip-app/services/spite/lib/task-17-server-writers.test.ts`

**Interfaces:**
- Existing explicit `enableAudio` remains persisted; missing/new values resolve to `true`.

- [ ] **Step 1: Write failing source/behavior tests** proving the toggle is absent, missing values render enabled, new nodes persist `enableAudio: true`, and explicit legacy `false` remains false.
- [ ] **Step 2: Run focused tests** and verify failures.
- [ ] **Step 3: Remove the toggle UI** and replace all nullish/default fallbacks with `true` while retaining explicit false values via `data.enableAudio ?? true`.
- [ ] **Step 4: Run tests** and confirm zero failures.
- [ ] **Step 5: Commit** `fix(canvas): default media sound on`.

### Task 8: Reconciliation report and acceptance verification

**Files:**
- Create: `nexoclip-app/scripts/report-byteplus-asset-links.mjs`
- Test: `nexoclip-app/tests/assets/byteplusAssetReconciliation.test.mjs`

**Interfaces:**
- Read-only command: `node scripts/report-byteplus-asset-links.mjs`; outputs counts/IDs/status/project mismatch without secrets and performs no deletion.

- [ ] **Step 1: Write failing report tests** for missing provider IDs, stale active mappings, project mismatch, redaction, and zero write queries.
- [ ] **Step 2: Implement the read-only report** using repository reads and optional provider status checks with bounded concurrency.
- [ ] **Step 3: Run report tests** and confirm zero failures.
- [ ] **Step 4: Run complete focused matrix:** BytePlus client, repository, unified service, routes, generation, Trust status, Canvas cleanup, sound behavior, `git diff --check`, and Docker builds for app/Spite/realtime/video worker.
- [ ] **Step 5: Request code review** and fix every Critical/Important finding.
- [ ] **Step 6: Commit** `chore(assets): report stale BytePlus links`.

## Rollout Gate

Do not deploy or run provider deletions automatically. After all tests pass, review the read-only reconciliation report first, deploy app/HTTP/Spite/realtime/workers, hard refresh, then manually delete one test asset and verify BytePlus, storage, database, and Canvas cleanup before approving broader use.
