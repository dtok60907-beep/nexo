# Canvas Image Trust Controls Design

## Goal

Allow users to trust any usable Canvas image for BytePlus Seedance directly from an Image Generator node, a Reference/Upload node, or the Assets toolbar folder detail view.

## UX

Image-bearing Canvas nodes expose a shield action in the selected-node toolbar. The action shows `Trust for Seedance`, `Trusting…`, `Trusted`, or `Retry trust`. Character, Prop, and Location folder images open in the existing right detail pane and show the same control below the preview.

Video and audio media never show the action. Duplicate clicks are disabled. Processing status polls with the existing bounded, visibility-aware behavior.

## Canonical workspace assets

BytePlus mappings remain keyed by main-app `workspace_id + local_asset_id`. A canonical `/api/assets/<uuid>/download` URL is trusted directly. For an owned Canvas image that still uses a legacy proxy/blob URL, the browser reads the already displayed image bytes and uploads them through a new authenticated main-app multipart import route. The client then persists the canonical URL on the owned Spite generation-history record and/or Canvas node before starting trust.

The server never fetches an arbitrary client URL. Import validates image MIME type, size, authentication, and workspace ownership. Provider Asset IDs and `asset://` URIs remain server-only.

## Data flow

1. Resolve a canonical workspace asset ID from the node/folder image URL.
2. If absent, fetch the image in the authenticated browser, import its bytes into the main workspace, and persist the returned canonical URL.
3. POST `/api/assets/<assetId>/byteplus-trust`.
4. Poll the existing GET route while visible and processing.
5. Broadcast an asset-status event so other views refresh.
6. Seedance mention/reference resolution finds the canonical asset URL and substitutes the active BytePlus `asset://` mapping in the video worker.

## Failure behavior

Missing/corrupt source bytes produce `Source image is unavailable`; no mapping is fabricated. Authentication/configuration/provider errors retain the existing safe copy. Failed imports remain retryable and do not overwrite the visible node image.

## Testing

Cover canonical URL parsing, image import validation/storage, duplicate request prevention, Canvas node visibility, folder-detail visibility, status projection, canonical URL persistence, and rejection of video/audio/arbitrary server-side URLs.
