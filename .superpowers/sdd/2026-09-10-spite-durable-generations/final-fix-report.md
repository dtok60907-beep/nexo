# Final durable-generation fix report

## Commit

`4287303 fix(spite): harden durable generation ownership`

## Fixed

- Resolves Spite UI model IDs through `getModelById()` and submits only the configured NexoClip `providerModel`.
- Makes terminal reconciliation compare-and-set on the current durable `generationId`; an old poll cannot overwrite a newer job.
- Removes the mobile trust-boundary bypass. Mobile creates an owned, durable `imageGen` CRDT node through a server route, then uses the normal submit/status validation and reconciliation path.
- Gives each canvas submit/retry a stable submission key and an authoritative node claim, preventing concurrent/retried callers from reserving duplicate jobs/credits.

## Regression coverage

- UI-model to provider-model translation and stable submission key.
- Terminal status mutation carries the generation-ID compare-and-set guard.
- Existing node ownership/type validation remains exercised for all submissions.
- Existing terminal idempotency and recovery coverage passes.

## Verification

Passed:

```text
cd nexoclip-app/services/spite
npx tsx --test \
  lib/task-17-server-writers.test.ts \
  lib/durable-generation.test.ts \
  lib/nexoclip-generation-client.test.ts \
  hooks/use-realtime-canvas.test.ts
# 23 passed, 0 failed
```

Environment-limited checks:

- `node --test app/api/internal/generations/route.test.mjs` could not resolve `pg` from the fresh worktree because dependencies are not installed there.
- `tsx --test realtime/server-core.test.ts lib/realtime/internal-client.test.ts` exceeded the 120-second harness timeout.
- Full `tsc --noEmit` is blocked by the same fresh-worktree dependency absence (missing React/Yjs/Next and related packages).

## Concern

The focused Spite suite is green. Re-run the bridge and realtime-server suites in CI or an installed workspace before merge to cover the new server-side conditional mutation and mobile node-creation transport end-to-end.
