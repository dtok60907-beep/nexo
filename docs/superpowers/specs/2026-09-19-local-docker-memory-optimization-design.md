# Local Docker Memory Optimization Design

## Goal

Reduce the local NexoClip Docker stack from roughly 5 GB of host memory to a practical 2–3 GB range without weakening production deployment settings or preventing normal Canvas, Assets, image, and video development.

## Scope

This change affects only the repository's local `docker-compose.yml`. It does not modify Railway configuration, production service sizing, Docker Desktop's global VM allocation, application APIs, or persisted volumes.

## Design

### Default stack

`docker compose up` continues to start the services needed for normal local development:

- Caddy
- NexoClip app
- Spite HTTP
- Spite realtime
- PostgreSQL
- Redis
- image worker
- video worker
- one-shot migration and storage initialization jobs

The image and video workers default to concurrency `1` locally instead of `3`. Explicit `IMAGE_WORKER_CONCURRENCY` and `VIDEO_WORKER_CONCURRENCY` environment values continue to override that default.

### AI Clip profile

`ai-clip` moves behind the Compose profile `ai-clip`. The NexoClip app no longer waits for AI Clip to become healthy during ordinary startup. Its configured AI Clip URL remains unchanged, so only AI Clip-specific requests are unavailable when the profile is disabled.

AI Clip can be enabled explicitly:

```bash
rtk docker compose --profile ai-clip up -d
```

### Runtime memory limits

Compose-level memory limits bound runaway local services while leaving enough headroom for Next.js and generation polling:

| Service | Limit |
|---|---:|
| Caddy | 128 MB |
| PostgreSQL | 512 MB |
| Redis | 256 MB |
| NexoClip app | 768 MB |
| Spite HTTP | 768 MB |
| Spite realtime | 384 MB |
| image worker | 512 MB |
| video worker | 512 MB |
| AI Clip, when enabled | 1 GB |

One-shot migration and initialization containers do not receive persistent runtime budgets because they exit after completing.

These are container ceilings, not reserved memory. Actual steady-state usage should remain below their sum.

## Build behavior

Local builds must run one service at a time rather than requesting parallel builds for multiple large Next.js targets. No wrapper script or new dependency is needed; existing Compose commands remain sufficient.

## Failure behavior

- If a service exceeds its memory limit, Docker may terminate that service rather than allowing the entire Docker VM to consume unbounded memory.
- If a normal workload proves too large for one limit, the limit can be overridden deliberately in Compose rather than raising every service globally.
- AI Clip routes may report their existing unavailable error while the profile is disabled; Canvas and standard image/video flows remain available.

## Verification

Verification is intentionally static until the user allows Docker to run again:

1. Render Compose configuration and confirm profiles/dependencies are valid.
2. Confirm `ai-clip` is absent from the default service set.
3. Confirm `ai-clip` appears with `--profile ai-clip`.
4. Confirm all intended memory limits and worker concurrency defaults are rendered.
5. Run `git diff --check`.

A later runtime check may use `docker stats --no-stream` after the stack has settled, but Docker will not be started as part of this implementation unless explicitly approved.
