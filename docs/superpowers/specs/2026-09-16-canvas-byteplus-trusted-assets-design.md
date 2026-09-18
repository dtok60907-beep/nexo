# Canvas BytePlus Trusted Assets Design

## Goal

Allow a Canvas user to explicitly mark a workspace image as trusted for BytePlus Seedance. NexoClip uploads the image to BytePlus's private virtual portrait library, tracks asynchronous preprocessing, and automatically sends the resulting `asset://<AssetId>` URI when that image is used with a BytePlus Seedance model.

This addresses BytePlus rejecting photorealistic AI character references sent as raw URLs while accepting the same characters after they become active private-library assets.

## Scope

### Included

- A **Trust for Seedance** action for workspace image assets.
- BytePlus virtual portrait asset-group and asset creation.
- Asynchronous status refresh through `GetAsset`.
- Workspace-scoped persistence of local-to-BytePlus asset mappings.
- Automatic substitution of active trusted assets during BytePlus Seedance video generation.
- Clear disabled, processing, active, and failed states.
- Unit and integration coverage with a mocked BytePlus Assets API client.

### Excluded

- Automatic upload of every Canvas image.
- Real-human identity verification flows.
- Managing paid Advanced Creation Rights subscriptions.
- Trusting video or audio assets in the first version.
- A general multi-provider asset synchronization framework.
- Automatic deletion of BytePlus assets when a local asset is deleted.

## Existing Behavior

Canvas video requests contain tenant-owned references such as `/api/assets/<id>/download`. `validateVideoGenerationInput` accepts only tenant asset URLs (plus explicitly enabled legacy Canvas URLs). `resolveReferenceImages` reads those objects and converts them to data URLs. `byteplusAdapter` then sends each resolved value as `content[].image_url.url` with role `reference_image`.

This works for ordinary images, but BytePlus may reject photorealistic character references as possible real people. A tested request using active private-library URIs (`asset://asset-...`) passed moderation and completed successfully.

## User Experience

A workspace image asset exposes a **Trust for Seedance** action.

The action has four states:

- **Not trusted**: action is enabled.
- **Processing**: action is disabled and status can be refreshed automatically.
- **Active**: show a trusted indicator; the image is eligible for BytePlus substitution.
- **Failed**: show the provider's safe error message and a retry action.

On first use, NexoClip creates a BytePlus AIGC asset group for the local asset, uploads the image, and records the returned identifiers. One group per local asset is acceptable for the first version because current character references are character sheets and the Entry tier's asset and group limits are equal. Group reuse across multiple local images of one character is deferred until a concrete Canvas character identity model requires it.

If BytePlus Assets API credentials are absent, the action remains visible but returns a setup message: `BytePlus Assets API is not configured.` Existing uploads and generation paths remain unaffected.

## Architecture

### Persistence

Add `byteplus_asset_links` with:

- `id UUID PRIMARY KEY`
- `workspace_id UUID NOT NULL`
- `local_asset_id UUID NOT NULL`
- `group_id TEXT`
- `provider_asset_id TEXT`
- `status TEXT NOT NULL` constrained to `processing`, `active`, or `failed`
- `error JSONB`
- `project_name TEXT NOT NULL DEFAULT 'default'`
- timestamps
- unique constraint on `(workspace_id, local_asset_id)`
- foreign key to the workspace-owned local asset

The workspace key is mandatory at every lookup. A client-provided `asset://` URI is never accepted directly, preventing cross-workspace use of provider assets from the shared BytePlus project.

### BytePlus Assets Client

Add a focused BytePlus Assets API client with three operations:

- `createAssetGroup`
- `createAsset`
- `getAsset`

Assets API calls use BytePlus AK/SK authentication in `ap-southeast-1`, service `ark`, API version `2024-01-01`, and `ProjectName` from configuration. Generation continues using the existing `BYTEPLUS_API_KEY`.

Required configuration:

- `BYTEPLUS_ACCESS_KEY_ID`
- `BYTEPLUS_SECRET_ACCESS_KEY`
- `BYTEPLUS_PROJECT_NAME` (default `default`)
- `BYTEPLUS_REGION` (default `ap-southeast-1`)

`CreateAsset` receives a short-lived URL for the existing local object, `AssetType: Image`, and `Moderation.Strategy: Skip`. The BytePlus console authorization letter and content pre-filter setting remain account setup prerequisites; NexoClip does not attempt to automate them.

Use an official already-compatible BytePlus SDK if the repository already has one at implementation time. Otherwise implement only the required signed universal API calls rather than introducing a broad provider abstraction.

### API Routes

#### Start trust operation

`POST /api/assets/:assetId/byteplus-trust`

- Authenticate the user and workspace.
- Load the asset by both workspace and asset ID.
- Reject non-image assets.
- Return the existing active or processing link idempotently.
- Create a group and asset when no usable mapping exists.
- Persist `processing` and return the safe mapping state.

#### Refresh trust status

`GET /api/assets/:assetId/byteplus-trust`

- Authenticate and scope by workspace.
- Return `not_trusted` if no mapping exists.
- If processing, call `GetAsset` and persist the latest status.
- Map BytePlus `Active` to local `active`, `Failed` to `failed`, and all pending states to `processing`.
- Never return AK/SK, raw signed URLs, or unrestricted provider metadata.

The UI polls only while visible and processing. Closing the page does not lose work; the next GET resumes status refresh.

### Generation Substitution

Keep request validation strict: Canvas continues sending only tenant asset references.

During video reference resolution:

1. Determine whether the resolved model routes directly to BytePlus Seedance.
2. For each tenant image reference, load its workspace-scoped trusted mapping.
3. If mapping is active, return `asset://<provider_asset_id>` without downloading or base64-encoding the image.
4. If no mapping exists, preserve the current raw-image behavior for non-character assets.
5. If a mapping exists but is processing or failed, reject generation with an actionable error instead of silently falling back to the raw character image.

Ordering is unchanged, so prompt references such as `Image 1` continue to match the image's position in the request body. Non-BytePlus models always use the current local object resolution path.

## Error Handling

- Missing AK/SK: `503 BYTEPLUS_ASSETS_NOT_CONFIGURED`.
- Unauthorized local asset: return the existing not-found behavior to avoid disclosing cross-workspace existence.
- Unsupported media type: `400 BYTEPLUS_ASSET_TYPE_UNSUPPORTED`.
- BytePlus rate limit or transient server failure: keep/revert state to processing and return a retryable response.
- BytePlus terminal preprocessing failure: persist a safe failure code/message and allow explicit retry.
- Active mapping with missing provider ID: treat as failed local state; never construct an invalid URI.
- Duplicate clicks: unique constraint plus idempotent lookup prevents duplicate uploads.

Provider response bodies may contain implementation details and must not be exposed verbatim to browser clients or durable public job errors.

## Security

- Never accept arbitrary provider asset IDs from Canvas generation requests.
- Resolve mappings server-side by `(workspace_id, local_asset_id)`.
- Keep AK/SK server-only and out of logs.
- Use short-lived source URLs for `CreateAsset`.
- Restrict the BytePlus IAM identity to `ark:*Asset*` and the intended project where possible.
- Require the BytePlus asset `ProjectName` to match the inference endpoint's project.
- Preserve existing workspace authorization on every route and repository query.

## Testing

### Unit tests

- Assets client builds the expected CreateAssetGroup, CreateAsset, and GetAsset operations without logging credentials.
- Status mapping handles Active, Failed, and pending states.
- Trusted resolution emits `asset://<id>` only for active, workspace-owned mappings and BytePlus Seedance.
- Non-BytePlus generation retains raw reference resolution.
- Processing and failed trusted mappings produce actionable errors.

### Route tests

- Unauthenticated and cross-workspace requests cannot access mappings.
- Duplicate POST requests are idempotent.
- GET advances processing to active or failed using mocked provider responses.
- Missing configuration returns the setup error without changing existing generation behavior.

### Adapter regression test

Verify that `byteplusAdapter` preserves an `asset://` image URL unchanged in `content[].image_url.url` and preserves image ordering.

No live BytePlus call is required in the automated suite. A manual acceptance test can use one known active virtual portrait and confirm that generation submission is accepted.

## Rollout

1. Deploy migration and backend with the feature configuration-gated.
2. Add AK/SK and matching project configuration to Railway.
3. Confirm the console authorization letter and content pre-filter setup.
4. Enable the Canvas action.
5. Trust one test character, wait for Active, and submit a Seedance 2.5 generation.
6. Monitor Assets API failures and Entry-tier QPM/asset limits.

Existing Canvas assets, jobs, and providers require no migration beyond the new optional mapping table.
