# BytePlus Trusted Asset Delete Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent local deletion of trusted assets unless BytePlus deletion succeeds or BytePlus confirms the provider asset is already missing.

**Architecture:** Keep the existing unified NexoClip deletion service as the provider-first boundary. Tighten the Spite proxy fallback so only non-workspace legacy assets may fall back after a `404`; canonical workspace assets must preserve their local record and propagate the failure. Add user-visible failure feedback in the Spite asset library.

**Tech Stack:** Node.js `node:test`, Next.js App Router route handlers, TypeScript React client component, PostgreSQL-backed asset metadata, BytePlus signed HTTP client.

## Global Constraints

- Trusted/BytePlus assets must call BytePlus `DeleteAsset` before local cleanup.
- Provider failure must preserve Canvas references, storage, provider mappings, generation outputs, and local asset metadata.
- Provider not-found is idempotent success and may continue local cleanup.
- Legacy non-workspace assets retain their existing local fallback deletion behavior.
- Do not expose BytePlus credentials or provider response details in API responses.
- No orphan reconciliation job is included in this change.

---

### Task 1: Lock down the Spite proxy fallback with failing tests

**Files:**
- Modify: `nexoclip-app/services/spite/lib/task-17-server-writers.test.ts` near the existing asset DELETE tests
- Inspect/modify: `nexoclip-app/services/spite/app/api/assets/[assetId]/route.ts`

**Interfaces:**
- Consumes the existing `createAssetRouteHandlers` dependency seams: `getDb`, `getAuthenticatedUser`, `fetchFn`, `getR2Client`, and realtime client.
- Produces the route behavior where a canonical workspace asset cannot enter legacy cleanup after upstream `404`.

- [ ] **Step 1: Add a failing test for canonical workspace `404` preservation**

Add a test using the existing route test helpers and a generation asset whose `r2_url` is a canonical workspace URL such as `/api/assets/978ba173-d6ce-4c3e-8830-83cd4ca66092/download`. Make `fetchFn` return `404` for the upstream NexoClip DELETE. Assert the response is `404`, assert the SQL mock did not delete `generation_history`, and assert the R2 client did not receive `DeleteObjectCommand`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
rtk proxy node --test nexoclip-app/services/spite/lib/task-17-server-writers.test.ts
```

Expected: the new test fails because the route currently treats every upstream `404` as permission to execute legacy cleanup.

- [ ] **Step 3: Implement the smallest route guard**

In the `DELETE` handler, after the upstream response is received, keep the current behavior for non-404 responses. For upstream `404`, inspect the resolved Spite asset before fallback. If its `r2_url` is a canonical `/api/assets/<UUID>/download` workspace URL, return the upstream `404` response immediately. Only proceed to the existing legacy cleanup when the asset is not a canonical workspace asset.

Use the existing `assetKeyFromUrl`/workspace asset URL conventions rather than adding a new database column or provider call.

- [ ] **Step 4: Add the legacy regression test**

Add a test with a non-canonical legacy `r2_url` such as `/uploads/legacy-image.png`. With upstream `404`, assert the route still removes the legacy generation record and returns success. This proves backward compatibility.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
rtk proxy node --test nexoclip-app/services/spite/lib/task-17-server-writers.test.ts
```

Expected: existing tests and both new fallback tests pass.

- [ ] **Step 6: Commit the route and tests**

```bash
rtk git add nexoclip-app/services/spite/app/api/assets/'[assetId]'/route.ts nexoclip-app/services/spite/lib/task-17-server-writers.test.ts
rtk git commit -m "fix: preserve trusted assets on delete fallback"
```

---

### Task 2: Verify provider-first unified deletion behavior

**Files:**
- Modify if required: `nexoclip-app/tests/assets/unifiedAssetDeletionService.test.mjs`
- Modify only if a failing test exposes a regression: `nexoclip-app/src/services/unifiedAssetDeletionService.js`

**Interfaces:**
- Consumes `deleteTrustedWorkspaceAsset({ workspaceId, localAssetId, pool, storage, bytePlusClient, cleanupCanvasReferences, configuredProjectName })`.
- Produces a guarantee that provider failure stops all local cleanup and provider not-found continues idempotently.

- [ ] **Step 1: Review existing provider ordering tests**

Confirm the existing tests assert both `transient provider failure preserves every local system` and `provider not found is idempotent and still cleans locally`. Extend only if the assertions do not cover call ordering.

- [ ] **Step 2: Add an explicit call-order assertion if missing**

Record calls in the existing test fixture and assert the provider call occurs before `CANVAS`, `STORAGE`, and final database deletion. For provider failure, assert none of those cleanup calls occur.

- [ ] **Step 3: Run the focused unified deletion tests**

```bash
rtk proxy node --test nexoclip-app/tests/assets/unifiedAssetDeletionService.test.mjs
```

Expected: all tests pass. No implementation change is expected unless the test exposes a real ordering regression.

- [ ] **Step 4: Commit any required service/test adjustment**

```bash
rtk git add nexoclip-app/src/services/unifiedAssetDeletionService.js nexoclip-app/tests/assets/unifiedAssetDeletionService.test.mjs
rtk git commit -m "test: enforce provider-first asset cleanup"
```

---

### Task 3: Surface delete failures in the asset library UI

**Files:**
- Modify: `nexoclip-app/services/spite/app/assets/page.tsx`

**Interfaces:**
- Consumes the existing `handleDelete(assetId: string)` function and current asset state.
- Produces visible feedback for non-2xx DELETE responses while preserving the selected asset in the list.

- [ ] **Step 1: Add the failure behavior test if a component test harness exists**

Inspect the existing Spite component test setup. If there is no test harness for this page, do not add a new testing framework; verify the behavior through the route tests and a manual browser request. The required behavior is that `setAssets` runs only for `res.ok` and non-OK responses display the returned error message.

- [ ] **Step 2: Implement minimal user feedback**

Update `handleDelete` so a non-OK response parses the JSON error when available and displays it using the page's existing notification pattern. Do not remove the asset from `assets` or clear `selectedAsset` on failure. Keep the existing `finally` reset of `deleting`.

- [ ] **Step 3: Run type/lint validation for the changed page**

Run the repository's applicable check from `nexoclip-app`:

```bash
cd nexoclip-app
rtk npm run lint
```

If the repository's Next lint script is unavailable under the installed Next version, run the existing TypeScript/test checks used by the Spite service and record the limitation rather than changing unrelated tooling.

- [ ] **Step 4: Commit the UI change**

```bash
rtk git add nexoclip-app/services/spite/app/assets/page.tsx
rtk git commit -m "fix: show asset deletion failures"
```

---

### Task 4: Run the complete verification suite

**Files:**
- No source changes expected.

- [ ] **Step 1: Run all affected Node tests**

```bash
rtk proxy node --test \
  nexoclip-app/tests/assets/assetDeleteRoute.test.mjs \
  nexoclip-app/tests/assets/unifiedAssetDeletionService.test.mjs \
  nexoclip-app/tests/providers/byteplusAssetsClient.test.mjs
```

- [ ] **Step 2: Run the affected Spite tests**

```bash
cd nexoclip-app/services/spite
rtk npm test -- --runInBand
```

If the service uses a different documented test script, inspect its `package.json` and run the narrow task-17/asset test command instead.

- [ ] **Step 3: Inspect the final diff and status**

```bash
rtk git diff HEAD~3..HEAD --stat
rtk git status --short
```

Expected: only the deletion route, relevant tests, and asset-library UI are changed; working tree is clean after commits.

- [ ] **Step 4: Manual acceptance test**

With the stack rebuilt from the current branch:

```bash
rtk docker compose up -d --build nexoclip-app spite
```

Attempt delete for a trusted asset while BytePlus is unavailable or rejects deletion. Verify:

1. UI shows an error.
2. The asset remains in the local asset list/database.
3. No storage/Canvas cleanup occurred.
4. After BytePlus deletion succeeds, retry removes local metadata and storage.
