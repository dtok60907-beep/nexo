# Local Docker Memory Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the default local Docker stack's memory footprint to approximately 2–3 GB while retaining normal Canvas, Assets, image, and video development.

**Architecture:** Keep the normal app, Canvas, persistence, and generation workers in the default Compose stack with explicit memory ceilings and worker concurrency `1`. Move only the heavyweight Python AI Clip runtime behind an opt-in Compose profile and remove it from the app's startup dependencies.

**Tech Stack:** Docker Compose, YAML, existing NexoClip Dockerfiles

## Global Constraints

- Modify only local `docker-compose.yml`; do not modify Railway or production service sizing.
- Do not start Docker or run containers during implementation.
- Preserve existing volumes, networks, secrets, URLs, and service names.
- `docker compose up` must retain Canvas, Assets, image generation, and video generation.
- AI Clip must require `--profile ai-clip`.
- Explicit worker concurrency environment values must continue to override local defaults.
- Add no dependencies or wrapper scripts.

---

### Task 1: Bound the local Compose stack

**Files:**
- Modify: `docker-compose.yml`
- Test: static Compose rendering commands; no test file required

**Interfaces:**
- Consumes: existing Compose services and environment interpolation
- Produces: default service set without `ai-clip`; optional `ai-clip` profile; per-service `mem_limit` ceilings

- [ ] **Step 1: Record failing static assertions**

Run without starting Docker:

```bash
rtk grep -n 'profiles:.*ai-clip' docker-compose.yml
rtk grep -n 'mem_limit:' docker-compose.yml
rtk grep -n 'IMAGE_WORKER_CONCURRENCY.*:-1' docker-compose.yml
rtk grep -n 'VIDEO_WORKER_CONCURRENCY.*:-1' docker-compose.yml
```

Expected: all four checks fail because the current Compose file has no profile, no memory limits, and worker defaults of `3`.

- [ ] **Step 2: Add memory ceilings**

Add these exact `mem_limit` entries to their service definitions:

```yaml
caddy:
  mem_limit: 128m

nexoclip-postgres:
  mem_limit: 512m

nexoclip-redis:
  mem_limit: 256m

nexoclip-image-worker:
  mem_limit: 512m

nexoclip-video-worker:
  mem_limit: 512m

spite:
  mem_limit: 768m

spite-realtime:
  mem_limit: 384m

nexoclip-app:
  mem_limit: 768m
```

Add `mem_limit: 1g` to `ai-clip`.

- [ ] **Step 3: Make AI Clip opt-in**

Add the exact profile to `ai-clip`:

```yaml
profiles: ["ai-clip"]
```

Remove this block from `nexoclip-app.depends_on`:

```yaml
ai-clip:
  condition: service_healthy
```

Keep `AI_CLIP_RUNTIME_URL` and `AI_CLIP_RUNTIME_TOKEN` unchanged so profile-enabled behavior remains compatible.

- [ ] **Step 4: Lower local worker concurrency defaults**

Change only the fallback values:

```yaml
IMAGE_WORKER_CONCURRENCY: ${IMAGE_WORKER_CONCURRENCY:-1}
VIDEO_WORKER_CONCURRENCY: ${VIDEO_WORKER_CONCURRENCY:-1}
```

- [ ] **Step 5: Verify source assertions**

Run:

```bash
rtk grep -n 'profiles:.*ai-clip' docker-compose.yml
rtk grep -n 'mem_limit:' docker-compose.yml
rtk grep -n 'IMAGE_WORKER_CONCURRENCY.*:-1' docker-compose.yml
rtk grep -n 'VIDEO_WORKER_CONCURRENCY.*:-1' docker-compose.yml
```

Expected: one AI Clip profile, nine memory limits, and both concurrency defaults equal `1`.

- [ ] **Step 6: Render the default Compose model without starting services**

Run:

```bash
rtk docker compose --env-file .env config --services
```

Expected: exits `0`; includes `nexoclip-app`, `spite`, `spite-realtime`, both workers, PostgreSQL, Redis, and Caddy; excludes `ai-clip`.

- [ ] **Step 7: Render the profile-enabled Compose model without starting services**

Run:

```bash
rtk docker compose --env-file .env --profile ai-clip config --services
```

Expected: exits `0` and includes `ai-clip` in addition to the default services.

- [ ] **Step 8: Inspect rendered limits and dependency removal**

Run:

```bash
rtk docker compose --env-file .env config > /tmp/nexoclip-compose-config.yml
rtk grep -n 'mem_limit:' /tmp/nexoclip-compose-config.yml
rtk grep -n -A20 '^  nexoclip-app:' /tmp/nexoclip-compose-config.yml
```

Expected: rendered memory limits are present and `nexoclip-app.depends_on` does not contain `ai-clip`.

- [ ] **Step 9: Verify formatting and commit**

Run:

```bash
rtk git diff --check
rtk git add docker-compose.yml
rtk git commit -m "chore(docker): reduce local memory footprint"
```

Expected: clean diff check and one focused commit.
