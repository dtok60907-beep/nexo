# Canvas Image Trust Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose safe Seedance trust controls on every usable Canvas image and folder image detail.

**Architecture:** Reuse the existing BytePlus trust state helpers. Canonical workspace asset URLs trust directly; legacy browser-readable image bytes are imported through an authenticated multipart route, then their canonical URL is persisted before trust starts.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Node.js, PostgreSQL/R2, node:test.

## Global Constraints

- Never expose provider asset IDs or accept client `asset://` URIs.
- Import images only; enforce existing 50 MiB asset limit and MIME allowlist.
- Never fetch arbitrary client URLs on the server.
- Preserve project/workspace ownership and existing non-BytePlus behavior.
- Reuse existing polling, error projection, and status copy.

---

### Task 1: Canonical image import

**Files:**
- Create: `nexoclip-app/app/api/assets/import/route.js`
- Modify: `nexoclip-app/src/services/assetService.js`
- Test: `nexoclip-app/tests/assets/assetImportRoute.test.mjs`

**Interfaces:**
- Produces `importWorkspaceAsset(workspaceId, { filename, contentType, body }, storage, pool)`.
- `POST /api/assets/import` consumes authenticated multipart `file` and returns `{ asset, url }`.

- [ ] Write tests proving unauthenticated, non-image, oversized, and valid imports.
- [ ] Run tests and confirm failure because the route/service do not exist.
- [ ] Implement direct storage upload plus transactional metadata insertion.
- [ ] Run tests and confirm pass.
- [ ] Commit `feat(assets): import canvas images`.

### Task 2: Shared Canvas trust controller

**Files:**
- Modify: `nexoclip-app/services/spite/lib/byteplus-trust.ts`
- Create: `nexoclip-app/services/spite/components/canvas/trust-for-seedance.tsx`
- Test: `nexoclip-app/services/spite/lib/byteplus-trust.test.ts`

**Interfaces:**
- Produces `workspaceAssetIdFromUrl(url)`, `importImageForTrust(input)`, and reusable `TrustForSeedance`.
- Import reads bytes in the browser, calls `/api/assets/import`, and returns canonical ID/URL.

- [ ] Write failing parsing/import/status tests.
- [ ] Run focused tests and confirm expected failures.
- [ ] Move the existing trust UI into the shared component and implement minimal canonicalization helpers.
- [ ] Run focused tests and confirm pass.
- [ ] Commit `refactor(canvas): share Seedance trust control`.

### Task 3: Canvas image nodes

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/node-toolbar.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/image-node.tsx`
- Modify: `nexoclip-app/services/spite/components/canvas/nodes/reference-node.tsx`
- Test: `nexoclip-app/services/spite/lib/byteplus-trust.test.ts`

**Interfaces:**
- Node toolbar receives optional trust state/action.
- Image and image-only Reference nodes canonicalize, persist canonical media URL, start trust, and poll.

- [ ] Write failing source/markup tests for Image Generator and Reference nodes.
- [ ] Run focused tests and confirm failure.
- [ ] Add the shield action and node controllers; exclude audio/video/empty nodes.
- [ ] Run focused tests and confirm pass.
- [ ] Commit `feat(canvas): trust image nodes for Seedance`.

### Task 4: Folder image detail

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/left-toolbar.tsx`
- Modify: `nexoclip-app/services/spite/app/api/assets/[assetId]/route.ts`
- Test: `nexoclip-app/services/spite/lib/byteplus-trust.test.ts`
- Test: `nexoclip-app/services/spite/lib/task-11-security.test.ts`

**Interfaces:**
- Folder thumbnail click selects an image for the existing right detail pane.
- Owned legacy generation asset PATCH accepts only canonical main-app asset URLs.

- [ ] Write failing detail/persistence/ownership tests.
- [ ] Run focused tests and confirm failure.
- [ ] Render preview + shared trust control and persist canonical URL safely.
- [ ] Run focused tests and confirm pass.
- [ ] Commit `feat(canvas): trust folder images`.

### Task 5: Verification

- [ ] Run focused main-app asset tests.
- [ ] Run full Spite tests.
- [ ] Run main and Spite production builds.
- [ ] Run Docker Compose build and health smoke test without deleting volumes.
- [ ] Review `git diff --check`, secret scan, and working-tree status.
