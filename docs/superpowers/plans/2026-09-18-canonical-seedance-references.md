# Canonical Seedance References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Seedance image reference is a durable workspace asset with an active BytePlus Trust mapping, never a legacy URL or raw base64 image.

**Architecture:** A workspace asset UUID is the only reference identity across Asset Library, folders, Canvas nodes, and mentions. The Spite UI imports legacy media into the main Assets API once and stores the returned `workspaceAssetId`; the generation worker resolves only that UUID to `asset://<provider_asset_id>`. Seedance submissions containing legacy/non-trusted references are rejected before provider submission.

**Tech Stack:** Next.js App Router, TypeScript, Node.js, PostgreSQL, Yjs, BytePlus Asset Library.

## Global Constraints

- Trust identity is `workspace_id + workspaceAssetId`; URLs and filenames are presentation-only.
- BytePlus Seedance must send only `asset://<provider_asset_id>` image references.
- Never trust a provider asset ID supplied by the browser.
- Existing legacy folder entries are preserved until their canonical replacement succeeds.
- No generation retry or modification is performed for historical jobs.
- Ordinary playback/download continues redirecting directly to signed R2 URLs.

---

### Task 1: Make folder entries identify canonical workspace assets

**Files:**
- Modify: `nexoclip-app/services/spite/lib/folders-schema.ts`
- Modify: `nexoclip-app/services/spite/app/api/folders/route.ts`
- Modify: `nexoclip-app/services/spite/app/api/folders/[folderId]/route.ts`
- Modify: `nexoclip-app/services/spite/lib/folder-visibility.ts`
- Test: `nexoclip-app/services/spite/lib/folder-visibility.test.ts`

**Interfaces:**
- Consumes: `workspaceAssetId?: string` supplied by folder writes.
- Produces: folder GET assets shaped as `{ id, workspaceAssetId, r2_url, type }`.

- [ ] **Step 1: Write failing folder projection test**

```ts
assert.deepEqual(foldersWithUsableAssets([{ assets: [{
  id: 'legacy-id', workspaceAssetId: 'workspace-id', r2_url: '/spite/api/r2-image/a.png', type: 'image',
}] }]), [{ assets: [{
  id: 'legacy-id', workspaceAssetId: 'workspace-id', r2_url: '/spite/api/r2-image/a.png', type: 'image',
}] }])
```

- [ ] **Step 2: Run the folder test and verify it fails because the canonical ID is dropped.**

Run: `cd nexoclip-app/services/spite && ./node_modules/.bin/tsx --test lib/folder-visibility.test.ts`

- [ ] **Step 3: Add nullable `workspace_asset_id text` to `asset_folder_items`, preserving `asset_id` as the legacy display/source ID.**

```sql
ALTER TABLE asset_folder_items ADD COLUMN IF NOT EXISTS workspace_asset_id text;
CREATE INDEX IF NOT EXISTS idx_folder_items_workspace_asset ON asset_folder_items(workspace_asset_id)
WHERE workspace_asset_id IS NOT NULL;
```

- [ ] **Step 4: Return and persist `workspaceAssetId` on folder asset objects.**

```ts
{ id: row.asset_id, workspaceAssetId: row.workspace_asset_id ?? undefined, r2_url: row.r2_url, type: row.asset_type }
```

- [ ] **Step 5: Run the folder test and commit.**

```bash
git add nexoclip-app/services/spite/lib/folders-schema.ts nexoclip-app/services/spite/app/api/folders nexoclip-app/services/spite/lib/folder-visibility*
git commit -m "feat(folders): retain canonical workspace asset ids"
```

### Task 2: Canonicalize folder additions through the main Assets API

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/add-to-folder-modal.tsx`
- Modify: `nexoclip-app/services/spite/hooks/use-project-folders.ts`
- Modify: `nexoclip-app/app/api/assets/import/route.js`
- Modify: `nexoclip-app/src/services/assetService.js`
- Test: `nexoclip-app/tests/assets/assetImportRoute.test.mjs`

**Interfaces:**
- Consumes: an authenticated legacy media URL or browser file.
- Produces: `{ workspaceAssetId, url }`, where `workspaceAssetId` is the returned main Assets UUID.

- [ ] **Step 1: Write an import test proving an existing canonical workspace asset is returned without creating a new UUID.**

```js
assert.equal(response.workspaceAssetId, 'asset-existing')
assert.equal(storage.putCalls.length, 0)
```

- [ ] **Step 2: Run the test and verify the pre-change path creates/imports a duplicate.**

Run: `cd nexoclip-app && node --test tests/assets/assetImportRoute.test.mjs`

- [ ] **Step 3: Make folder-add call the authenticated canonical import endpoint once and save its `workspaceAssetId` alongside the preview URL.**

```ts
const canonical = await importWorkspaceAssetForFolder({ projectId, url: assetUrl })
setSelectedAssets([{ id: legacyId, workspaceAssetId: canonical.workspaceAssetId, url: canonical.url }])
```

- [ ] **Step 4: Refuse to save an image folder item when canonicalization fails; show the API error in the modal.**

```ts
if (!asset.workspaceAssetId) throw new Error('Import this image into Assets before adding it as a Seedance reference')
```

- [ ] **Step 5: Run the asset import test and commit.**

```bash
git add nexoclip-app/services/spite/components/canvas/add-to-folder-modal.tsx nexoclip-app/services/spite/hooks/use-project-folders.ts nexoclip-app/app/api/assets/import/route.js nexoclip-app/src/services/assetService.js nexoclip-app/tests/assets/assetImportRoute.test.mjs
git commit -m "fix(assets): canonicalize folder references"
```

### Task 3: Preserve canonical IDs in mentions and Canvas references

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/mention-textarea.tsx`
- Modify: `nexoclip-app/services/spite/lib/mention-prompt.ts`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/reference-node.tsx`
- Test: `nexoclip-app/services/spite/lib/mention-identity.test.ts`

**Interfaces:**
- Consumes: folder assets with `workspaceAssetId`.
- Produces: `Mention.selectedWorkspaceAssetIds: string[]` and reference groups containing canonical asset download URLs only.

- [ ] **Step 1: Write a failing mention identity test.**

```ts
assert.deepEqual(compileMentionsForModel('@Nathan', [{
  folderId: 'nathan', name: 'Nathan', selectedWorkspaceAssetIds: ['workspace-nathan'],
}], folders, seedance).refGroups[0].workspaceAssetIds, ['workspace-nathan'])
```

- [ ] **Step 2: Run the test and verify legacy `selectedAssetIds` are still emitted.**

Run: `cd nexoclip-app/services/spite && ./node_modules/.bin/tsx --test lib/mention-identity.test.ts`

- [ ] **Step 3: Migrate mention serialization to canonical IDs while reading old `selectedAssetIds` only for display compatibility.**

```ts
type Mention = { folderId: string; name: string; selectedWorkspaceAssetIds: string[] }
```

- [ ] **Step 4: Omit legacy-only folder assets from Seedance mention reference groups and expose a `needsCanonicalImport` validation error.**

```ts
if (!asset.workspaceAssetId) throw new Error(`${folder.name} contains a legacy reference; import it into Assets first`)
```

- [ ] **Step 5: Run the mention test and commit.**

```bash
git add nexoclip-app/services/spite/components/canvas/mention-textarea.tsx nexoclip-app/services/spite/lib/mention-prompt.ts nexoclip-app/services/spite/components/canvas/nodes/reference-node.tsx nexoclip-app/services/spite/lib/mention-identity.test.ts
git commit -m "fix(canvas): persist canonical mention assets"
```

### Task 4: Enforce zero-raw Seedance references before job submission

**Files:**
- Modify: `nexoclip-app/services/spite/app/api/generate/submit/route.ts`
- Modify: `nexoclip-app/src/services/saasVideoGeneration.js`
- Test: `nexoclip-app/services/spite/lib/task-11-security.test.ts`
- Test: `nexoclip-app/tests/generations/saasVideoGeneration.test.mjs`

**Interfaces:**
- Consumes: canonical workspace download URLs in `parameters.referenceImages`.
- Produces: `422` before provider submission for a Seedance legacy/raw/missing-trust reference.

- [ ] **Step 1: Write failing Seedance preflight tests.**

```ts
assert.equal(response.status, 422)
assert.match((await response.json()).error, /not trusted|legacy/i)
assert.equal(submitCalls, 0)
```

```js
await assert.rejects(handler(jobWithLegacyReference), (error) => error.code === 'BYTEPLUS_REFERENCE_NOT_TRUSTED')
assert.equal(providerRouter.submitVideoCalls, 0)
```

- [ ] **Step 2: Run both tests and verify current code queues/submits raw legacy references.**

Run: `cd nexoclip-app/services/spite && ./node_modules/.bin/tsx --test lib/task-11-security.test.ts && cd ../../ && node --test tests/generations/saasVideoGeneration.test.mjs`

- [ ] **Step 3: For `byteplus/seedance-*`, resolve every URL to a server-owned workspace asset and require an active mapping in the current BytePlus project.**

```js
if (isDirectBytePlusSeedance(job.model, env) && !resolved.startsWith('asset://')) {
  throw Object.assign(new Error('Every Seedance reference must be an active Trusted Asset.'), {
    code: 'BYTEPLUS_REFERENCE_NOT_TRUSTED', status: 422,
  })
}
```

- [ ] **Step 4: Return the folder/asset name in the UI-safe API error and never send `data:image` to Seedance.**

- [ ] **Step 5: Run both tests and commit.**

```bash
git add nexoclip-app/services/spite/app/api/generate/submit/route.ts nexoclip-app/src/services/saasVideoGeneration.js nexoclip-app/services/spite/lib/task-11-security.test.ts nexoclip-app/tests/generations/saasVideoGeneration.test.mjs
git commit -m "fix(seedance): reject non-trusted references"
```

### Task 5: Reconcile existing production folders without deleting originals

**Files:**
- Create: `nexoclip-app/scripts/reconcile-folder-workspace-assets.mjs`
- Test: `nexoclip-app/tests/assets/reconcileFolderWorkspaceAssets.test.mjs`

**Interfaces:**
- Consumes: project-scoped `asset_folder_items` whose `workspace_asset_id IS NULL`.
- Produces: updated rows with a canonical workspace ID, or a report entry requiring manual import/Trust.

- [ ] **Step 1: Write a fixture test for a legacy item matching a canonical asset and an unmatched item.**

```js
assert.deepEqual(report, { updated: ['legacy-nathan'], manual: ['legacy-unknown'] })
```

- [ ] **Step 2: Run it and verify the script does not exist.**

Run: `cd nexoclip-app && node --test tests/assets/reconcileFolderWorkspaceAssets.test.mjs`

- [ ] **Step 3: Implement dry-run by default; accept `--apply --project <uuid>` and update only records whose canonical import/ownership verification succeeded.**

```bash
node scripts/reconcile-folder-workspace-assets.mjs --project 700ab24d-fdbb-469b-b1bd-442b1d2ab38c
node scripts/reconcile-folder-workspace-assets.mjs --apply --project 700ab24d-fdbb-469b-b1bd-442b1d2ab38c
```

- [ ] **Step 4: Run dry-run first; review each proposed mapping; apply only after explicit approval. Do not delete duplicate or legacy objects.**

- [ ] **Step 5: Run the test and commit the script.**

```bash
git add nexoclip-app/scripts/reconcile-folder-workspace-assets.mjs nexoclip-app/tests/assets/reconcileFolderWorkspaceAssets.test.mjs
git commit -m "feat(assets): reconcile legacy folder references"
```

### Task 6: Deploy and prove provider-safe references

**Files:**
- No source changes.

- [ ] **Step 1: Run focused tests.**

```bash
cd nexoclip-app && node --test tests/assets/assetImportRoute.test.mjs tests/assets/reconcileFolderWorkspaceAssets.test.mjs tests/generations/saasVideoGeneration.test.mjs
cd services/spite && ./node_modules/.bin/tsx --test lib/folder-visibility.test.ts lib/mention-identity.test.ts lib/task-11-security.test.ts
```

- [ ] **Step 2: Deploy `ai-ugc-spite`, `ai-ugc-http`, and `ai-ugc-video-worker`; wait for `SUCCESS`.**

- [ ] **Step 3: Hard-refresh every active Canvas browser tab.**

```text
Cmd + Shift + R
```

- [ ] **Step 4: Submit one Seedance job with Natasya, Nathan, and Mbok Dar. Inspect the saved job and worker request metadata.**

Expected:

```text
referenceImages all resolve to asset://asset-...
provider_request_id is present
no data:image reference is sent
```

- [ ] **Step 5: Verify the output with `ffprobe`; do not retry historical jobs.**

## Self-review

- Stable workspace identity is implemented by Tasks 1–3.
- Legacy references are not silently submitted by Task 4.
- Existing folders are preserved and reconciled only with explicit `--apply` approval in Task 5.
- Every new or changed behavior has a focused regression test.
- Task 6 verifies the exact provider-visible condition that caused the failures.
