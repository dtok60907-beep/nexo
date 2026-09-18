# Canvas BytePlus Trusted Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users trust workspace images into BytePlus's private portrait library and automatically substitute active `asset://` references for direct Seedance generation.

**Architecture:** The main app owns workspace-scoped mapping persistence, BytePlus AK/SK calls, trust routes, and worker-side substitution. Canvas calls the main routes directly using main-session authentication and renders the safe mapping state. Generation requests remain tenant URLs; only the video worker can resolve them to provider asset URIs.

**Tech Stack:** Next.js App Router, Node.js Web Crypto/crypto, PostgreSQL, BytePlus Ark universal API, BullMQ, React/SWR.

## Global Constraints

- Never accept arbitrary `asset://` values from clients.
- Scope every mapping query by `workspace_id` and `local_asset_id`.
- Preserve reference ordering and all non-BytePlus resolution behavior.
- Never expose/log AK/SK, signed source URLs, or raw provider failures.
- Add no dependency unless the installed tree already exposes an official compatible signer.
- Missing configuration returns `503 BYTEPLUS_ASSETS_NOT_CONFIGURED` without affecting ordinary generation.

---

### Task 1: Trusted asset persistence

**Files:**
- Create: `nexoclip-app/src/db/migrations/024_byteplus_asset_links.sql`
- Create: `nexoclip-app/src/repositories/byteplusAssetRepository.js`
- Test: `nexoclip-app/tests/assets/byteplusAssetRepository.test.mjs`

**Interfaces:**
- Produces workspace-scoped `findBytePlusAssetLink`, `createProcessingBytePlusAssetLink`, `updateBytePlusAssetLink`, and `resetBytePlusAssetLink` repository functions.

- [ ] Write failing repository/migration tests for FK, status constraint, uniqueness, workspace scoping, idempotent insert, and safe updates.
- [ ] Run tests and confirm failure because migration/repository are absent.
- [ ] Implement migration and minimal parameterized repository queries.
- [ ] Run tests and confirm pass.
- [ ] Commit persistence.

### Task 2: Focused BytePlus Assets API client

**Files:**
- Create: `nexoclip-app/src/providers/byteplusAssetsClient.js`
- Test: `nexoclip-app/tests/providers/byteplusAssetsClient.test.mjs`

**Interfaces:**
- Produces `createBytePlusAssetsClient({ env, fetchFn, now })` with `createAssetGroup`, `createAsset`, and `getAsset`.
- Produces `mapBytePlusAssetStatus(payload)` and safe typed errors.

- [ ] Write failing tests for configuration, signed query operations, required bodies, status mapping, transient errors, and credential redaction.
- [ ] Run tests and confirm missing-module failure.
- [ ] Implement Volcengine Signature V4 with `node:crypto`, region `ap-southeast-1`, service `ark`, API version `2024-01-01`, and only the three required actions.
- [ ] Run tests and confirm pass.
- [ ] Commit client.

### Task 3: Trust orchestration and authenticated route

**Files:**
- Create: `nexoclip-app/src/services/byteplusAssetTrustService.js`
- Create: `nexoclip-app/app/api/assets/[assetId]/byteplus-trust/route.js`
- Modify: `nexoclip-app/src/services/assetService.js`
- Modify: `nexoclip-app/app/api/assets/route.js`
- Test: `nexoclip-app/tests/assets/byteplusAssetTrustService.test.mjs`
- Test: `nexoclip-app/tests/assets/byteplusAssetTrustRoute.test.mjs`

**Interfaces:**
- `POST` starts/retries trust; `GET` returns/refreshes safe state `{ status, error? }`.
- Workspace asset listing includes `byteplus_trust` without provider IDs.

- [ ] Write failing tests for authentication, workspace isolation, image-only validation, idempotent POST, missing config, active/failed refresh, short-lived source URL, and safe response projection.
- [ ] Run tests and confirm failure.
- [ ] Implement service and route using existing session/default-workspace patterns and storage download URLs.
- [ ] Join safe trust state into workspace asset listing.
- [ ] Run tests and confirm pass.
- [ ] Commit trust API.

### Task 4: Worker-side trusted substitution

**Files:**
- Modify: `nexoclip-app/src/services/saasImageGeneration.js`
- Modify: `nexoclip-app/src/services/saasVideoGeneration.js`
- Modify: `nexoclip-app/src/queue/videoWorker.mjs`
- Modify: `nexoclip-app/src/providers/direct/byteplusAdapter.js`
- Test: `nexoclip-app/tests/generations/saasVideoGeneration.test.mjs`
- Test: `nexoclip-app/tests/providers/byteplusVideoAdapter.test.mjs`

**Interfaces:**
- Adds trusted-aware resolution for direct BytePlus Seedance only.
- Active mappings yield `asset://<provider_asset_id>`; processing/failed mappings throw actionable typed errors; absent mappings use existing data URLs.

- [ ] Write failing tests for active, missing, processing, failed, cross-workspace, non-BytePlus, frame ordering, and adapter URI preservation.
- [ ] Run tests and confirm failures.
- [ ] Implement model-route detection and server-only mapping substitution before object download.
- [ ] Inject required repository dependency into the video worker without changing image workers.
- [ ] Run tests and confirm pass.
- [ ] Commit generation substitution.

### Task 5: Canvas trust action and polling

**Files:**
- Modify: `nexoclip-app/services/spite/components/canvas/left-toolbar.tsx`
- Create: `nexoclip-app/services/spite/lib/byteplus-trust.ts`
- Test: `nexoclip-app/services/spite/lib/byteplus-trust.test.ts`

**Interfaces:**
- Calls unprefixed main-app `/api/assets/:id/byteplus-trust` endpoints.
- Displays not-trusted, processing, active, and failed states; polls only while the selected image is visible and processing.

- [ ] Write failing tests for main-app URL construction, state labels/actions, image-only visibility, polling condition, and safe failure copy.
- [ ] Run tests and confirm failure.
- [ ] Add the minimal action/status UI to both existing asset detail layouts, reusing current buttons and Sonner.
- [ ] Run tests and confirm pass.
- [ ] Commit Canvas UI.

### Task 6: Configuration and rollout verification

**Files:**
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `nexoclip-app/.env.example`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Test: `nexoclip-app/tests/deployment/dockerDeployment.test.mjs`

**Interfaces:**
- Configures `BYTEPLUS_ACCESS_KEY_ID`, `BYTEPLUS_SECRET_ACCESS_KEY`, `BYTEPLUS_PROJECT_NAME=default`, and `BYTEPLUS_REGION=ap-southeast-1` on main app and video worker only.

- [ ] Write failing deployment assertions for required service wiring and absence from browser-exposed variables.
- [ ] Run tests and confirm failure.
- [ ] Add examples and Compose wiring without secrets.
- [ ] Run provider, asset, generation, deployment, and full Spite suites plus production builds.
- [ ] Review the complete diff for security and spec compliance.
- [ ] Commit configuration and verification changes.
