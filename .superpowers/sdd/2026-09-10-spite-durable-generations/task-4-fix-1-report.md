# Task 4 fix 1 report

## Status
Fixed the Task 4 blocking review findings:

- Canvas image/video submitters now send `kind`/`model`, consume `generationId`/`generationStatus`, persist durable generation state, and poll only with the durable query contract.
- The mobile project caller uses the durable contract through an explicit `mobile` compatibility path that remains authenticated and project-owned but does not require a canvas node.
- Submit maps supported legacy fields to NexoClip validator parameters and rejects unsupported controls before job creation. Video references are checked as tenant asset URLs.
- Route test fakes now implement the complete durable client interface; ownership tests assert the durable client is untouched for non-owners.

## Verification

- `./node_modules/.bin/tsx --test lib/nexoclip-generation-client.test.ts lib/durable-generation.test.ts lib/task-17-server-writers.test.ts lib/project-ownership.test.ts lib/canvas-node-interactions.test.ts` — 29 passed.
- `tsc --noEmit` — Task 4-introduced test/interface errors are gone. The command still fails on 10 pre-existing errors in generated route types and unrelated tests (`.next/dev/types/validator.ts`, `resizable-node-frame.test.ts`, `main-session.test.ts`, `react-flow-binding.test.ts`, and `task-11-security.test.ts`).

## Concern
The durable service only accepts video references as `/api/assets/:id/download`; existing canvas references outside that namespace now fail clearly rather than being silently discarded. Existing direct-provider-only video controls are likewise rejected until the durable service supports them.
