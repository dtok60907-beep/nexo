import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));

const serviceBlock = (compose, name, nextName) => {
  const start = compose.indexOf(`  ${name}:\n`);
  const end = nextName ? compose.indexOf(`  ${nextName}:\n`, start + 1) : compose.indexOf('\nvolumes:', start + 1);
  assert.notEqual(start, -1, `missing service ${name}`);
  return compose.slice(start, end === -1 ? undefined : end);
};

const serviceBlocks = (compose, names) => Object.fromEntries(
  names.map((name, index) => [name, serviceBlock(compose, name, names[index + 1])]),
);

function publicEnvLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('NEXT_PUBLIC_') || line.startsWith('ARG NEXT_PUBLIC_') || line.startsWith('ENV NEXT_PUBLIC_'));
}

test('production compose is AMD64 and exposes only Caddy plus declared private services', () => {
  const compose = read('docker-compose.prod.yml');
  const names = [
    'caddy',
    'postgres',
    'redis',
    'nexoclip-migrate',
    'spite-realtime-migrate',
    'spite-ownership-migrate',
    'ai-clip',
    'nexoclip',
    'spite',
    'spite-realtime',
  ];
  const blocks = serviceBlocks(compose, names);

  assert.match(blocks.postgres, /POSTGRES_DB: nexoclip/);
  assert.match(blocks.postgres, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD\}/);
  assert.match(blocks.postgres, /postgres-data:\/var\/lib\/postgresql\/data/);

  for (const [name, block] of Object.entries(blocks)) {
    assert.match(block, /platform: linux\/amd64/);
    if (name === 'caddy') assert.match(block, /ports:/);
    else assert.doesNotMatch(block, /\n\s+ports:/);
  }

  assert.match(blocks['spite-realtime'], /\n\s+expose:\n\s+- "3007"/);
  assert.match(blocks['spite-realtime-migrate'], /target: migrate-realtime/);
  assert.match(blocks['spite-ownership-migrate'], /target: node-runtime/);
});

test('deployment files, routes, and documented realtime env exist', () => {
  for (const path of [
    'Caddyfile',
    'nexoclip-app/.dockerignore',
    'nexoclip-app/.env.example',
    '.env.production.example',
    'nexoclip-app/services/spite/Dockerfile',
    'nexoclip-app/services/ai-clip/Dockerfile',
  ]) {
    assert.equal(existsSync(path), true, `missing ${path}`);
  }

  const caddy = read('Caddyfile');
  const routeStart = caddy.search(/\broute\s*\{/);
  assert.notEqual(routeStart, -1, 'Caddy routing must use route so Caddy preserves declaration order');
  const route = caddy.slice(routeStart);
  assert.match(route, /handle_path \/ai-clip-api\/\*/);
  assert.match(route, /handle \/spite\/ws\*/);
  assert.match(route, /handle \/spite\*/);
  assert.match(route, /handle \/spite\/api\/internal\/\*\s*\{\s*respond 404\s*\}/);
  assert.match(route, /handle \/api\/internal\/\*\s*\{\s*respond 404\s*\}/);
  const orderedHandlers = [
    'handle_path /ai-clip-api/*',
    'handle /spite/api/internal/*',
    'handle /api/internal/*',
    'handle /spite/ws*',
    'handle /spite*',
    'handle {',
  ];
  for (const [index, handler] of orderedHandlers.entries()) {
    assert.ok(route.indexOf(handler) !== -1, `missing ${handler} in ordered route`);
    if (index > 0) {
      assert.ok(route.indexOf(orderedHandlers[index - 1]) < route.indexOf(handler), `${handler} must follow ${orderedHandlers[index - 1]}`);
    }
  }
  assert.doesNotMatch(caddy, /reverse_proxy[^\n]*internal\/authorize/);
  assert.doesNotMatch(caddy, /reverse_proxy[^\n]*internal\/document/);
  assert.doesNotMatch(caddy, /handle \/api\/internal\/generations/);
  assert.doesNotMatch(caddy, /handle \/scheduler\*/);

  const envExample = read('nexoclip-app/.env.example');
  assert.match(envExample, /^NEXT_PUBLIC_REALTIME_URL=\/spite\/ws$/m);

  const productionEnv = read('.env.production.example');
  for (const name of [
    'SPITE_OWNER_USER_ID',
    'CANVAS_AUTH_URL',
    'CANVAS_AUTH_HMAC_SECRET',
    'REALTIME_JWT_SECRET',
    'NEXOCLIP_INTERNAL_URL',
    'NEXT_PUBLIC_REALTIME_URL',
    'SPITE_REALTIME_MAX_QUEUED_UPDATES',
    'SPITE_REALTIME_MAX_QUEUED_BYTES',
    'SPITE_REALTIME_SNAPSHOT_INTERVAL_MS',
    'SPITE_REALTIME_COMPACT_AFTER_UPDATES',
  ]) {
    assert.match(productionEnv, new RegExp(`^${name}=`, 'm'));
  }
  assert.match(productionEnv, /^# SPITE_ALLOW_DETERMINISTIC_FIRST_USER=1$/m);
});

test('Docker context excludes secrets and Spite Dockerfile exposes Node 22 web/realtime targets', () => {
  const ignore = read('nexoclip-app/.dockerignore');
  assert.match(ignore, /^\.env\*$/m);
  assert.match(ignore, /^!\.env\.example$/m);
  assert.match(ignore, /^!\.env\.production\.example$/m);

  const dockerfile = read('nexoclip-app/services/spite/Dockerfile');
  assert.match(dockerfile, /^FROM node:22-bookworm-slim AS base$/m);
  assert.match(dockerfile, /^FROM base AS realtime$/m);
  assert.match(dockerfile, /^FROM base AS migrate-realtime$/m);
  assert.match(dockerfile, /^EXPOSE 3007$/m);
});

test('deploy script validates the host and runs config + migrations before startup', () => {
  const script = read('scripts/deploy.sh');
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/);
  assert.match(script, /DEPLOY_PROJECT_NAME="\$\{DEPLOY_PROJECT_NAME:-nexoclip-production\}"/);
  assert.match(script, /uname -m/);
  assert.match(script, /x86_64\/AMD64/);
  assert.match(script, /\[\[ -f "\$DEPLOY_ENV_FILE" \]\]/);
  assert.match(script, /Copy \.env\.production\.example to \.env\.production first\./);
  assert.match(script, /stat -c '%a' "\$DEPLOY_ENV_FILE"/);
  assert.match(script, /stat -f '%Lp' "\$DEPLOY_ENV_FILE"/);
  assert.match(script, /run --rm --no-deps[\s\S]*-e NODE_ENV=production[\s\S]*-e POSTGRES_PASSWORD[\s\S]*nexoclip-migrate node scripts\/production-config\.mjs/);
  assert.match(script, /config --quiet/);
  assert.ok(script.indexOf('"${compose[@]}" config --quiet') < script.indexOf('run --rm --no-deps'));
  assert.ok(script.indexOf('"${compose[@]}" config --quiet') < script.indexOf('run --rm nexoclip-migrate'));
  assert.ok(script.indexOf('"${compose[@]}" build') < script.indexOf('run --rm nexoclip-migrate'));
  assert.ok(script.indexOf('run --rm nexoclip-migrate') < script.indexOf('run --rm spite-realtime-migrate'));
  assert.ok(script.indexOf('run --rm spite-realtime-migrate') < script.indexOf('run --rm spite-ownership-migrate'));
  assert.ok(script.indexOf('run --rm spite-ownership-migrate') < script.indexOf('up -d --remove-orphans'));
  assert.doesNotMatch(script, /scheduler-migrate/);
  assert.match(script, /--wait --wait-timeout/);
  assert.match(script, /DEPLOY_WAIT_TIMEOUT/);
  assert.match(script, /logs --tail=100/);
  assert.match(script, /Deployment failed at line/);
  assert.match(script, /"\$\{compose\[@\]\}" ps/);
});

test('Compose isolates databases, routes websocket traffic privately, and shares only required secrets', () => {
  const compose = read('docker-compose.prod.yml');
  const names = [
    'caddy',
    'postgres',
    'redis',
    'nexoclip-migrate',
    'spite-realtime-migrate',
    'spite-ownership-migrate',
    'ai-clip',
    'nexoclip',
    'spite',
    'spite-realtime',
  ];
  const blocks = serviceBlocks(compose, names);

  assert.match(blocks.caddy, /\$\{HTTP_PORT:-80\}:80/);
  assert.match(blocks.caddy, /spite-realtime: \{ condition: service_healthy \}/);
  assert.match(blocks.postgres, /POSTGRES_DB: nexoclip/);
  assert.match(blocks.nexoclip, /postgresql:\/\/nexoclip:\$\{POSTGRES_PASSWORD\}@postgres:5432\/nexoclip/);
  assert.match(blocks.redis, /--requirepass/);
  assert.match(blocks.redis, /redis-cli -a/);

  assert.match(blocks.nexoclip, /NODE_ENV: production\n      NEXT_PUBLIC_SPITE_URL: \/spite/);
  assert.match(blocks.nexoclip, /DATABASE_URL_NEXOCLIP: postgresql:\/\/nexoclip:\$\{POSTGRES_PASSWORD\}@postgres:5432\/nexoclip/);
  assert.doesNotMatch(blocks.nexoclip, /DATABASE_URL_SPITE:/);
  assert.match(blocks.nexoclip, /CANVAS_AUTH_URL: \$\{CANVAS_AUTH_URL:\?CANVAS_AUTH_URL is required\}/);
  assert.match(blocks.nexoclip, /CANVAS_AUTH_HMAC_SECRET: \$\{CANVAS_AUTH_HMAC_SECRET\}/);
  assert.match(blocks.nexoclip, /REALTIME_JWT_SECRET: \$\{REALTIME_JWT_SECRET:\?REALTIME_JWT_SECRET is required\}/);

  assert.match(blocks.spite, /DATABASE_URL_SPITE: \$\{DATABASE_URL_SPITE\}/);
  assert.match(blocks.spite, /GEMINI_API_KEY: \$\{GEMINI_API_KEY\}/);
  assert.match(blocks.spite, /OPENAI_API_KEY: \$\{OPENAI_API_KEY\}/);
  assert.match(blocks.spite, /BYTEPLUS_API_KEY: \$\{BYTEPLUS_API_KEY\}/);
  assert.match(blocks.spite, /BYTEPLUS_BASE_URL: \$\{BYTEPLUS_BASE_URL\}/);
  assert.doesNotMatch(blocks.spite, /DATABASE_URL_NEXOCLIP:/);
  assert.match(blocks.spite, /NEXOCLIP_INTERNAL_URL: \$\{NEXOCLIP_INTERNAL_URL:\?NEXOCLIP_INTERNAL_URL is required\}/);
  assert.match(blocks.spite, /CANVAS_AUTH_URL: \$\{CANVAS_AUTH_URL:\?CANVAS_AUTH_URL is required\}/);
  assert.match(blocks.spite, /CANVAS_AUTH_HMAC_SECRET: \$\{CANVAS_AUTH_HMAC_SECRET\}/);
  assert.match(blocks.spite, /REALTIME_TOKEN_SECRET: \$\{REALTIME_JWT_SECRET:\?REALTIME_JWT_SECRET is required\}/);
  assert.match(blocks.spite, /NEXT_PUBLIC_REALTIME_URL: \$\{NEXT_PUBLIC_REALTIME_URL:\?NEXT_PUBLIC_REALTIME_URL is required\}/);

  assert.match(blocks['spite-realtime'], /DATABASE_URL_SPITE: \$\{DATABASE_URL_SPITE\}/);
  assert.doesNotMatch(blocks['spite-realtime'], /DATABASE_URL_NEXOCLIP:/);
  assert.match(blocks['spite-realtime'], /PORT: 3007/);
  assert.match(blocks['spite-realtime'], /REALTIME_JWT_SECRET: \$\{REALTIME_JWT_SECRET:\?REALTIME_JWT_SECRET is required\}/);
  assert.match(blocks['spite-realtime'], /CANVAS_AUTH_HMAC_SECRET: \$\{CANVAS_AUTH_HMAC_SECRET\}/);
  assert.match(blocks['spite-realtime'], /SPITE_REALTIME_MAX_QUEUED_UPDATES: \$\{SPITE_REALTIME_MAX_QUEUED_UPDATES:-256\}/);
  assert.match(blocks['spite-realtime'], /SPITE_REALTIME_MAX_QUEUED_BYTES: \$\{SPITE_REALTIME_MAX_QUEUED_BYTES:-524288\}/);
  assert.match(blocks['spite-realtime'], /SPITE_REALTIME_SNAPSHOT_INTERVAL_MS: \$\{SPITE_REALTIME_SNAPSHOT_INTERVAL_MS:-30000\}/);
  assert.match(blocks['spite-realtime'], /SPITE_REALTIME_COMPACT_AFTER_UPDATES: \$\{SPITE_REALTIME_COMPACT_AFTER_UPDATES:-128\}/);
  assert.match(blocks['spite-realtime'], /\/healthz/);

  assert.match(blocks['spite-realtime-migrate'], /DATABASE_URL_SPITE: \$\{DATABASE_URL_SPITE\}/);
  assert.match(blocks['spite-ownership-migrate'], /DATABASE_URL_NEXOCLIP: postgresql:\/\/nexoclip:\$\{POSTGRES_PASSWORD\}@postgres:5432\/nexoclip/);
  assert.match(blocks['spite-ownership-migrate'], /DATABASE_URL_SPITE: \$\{DATABASE_URL_SPITE\}/);
  assert.match(blocks['spite-ownership-migrate'], /SPITE_OWNER_USER_ID: \$\{SPITE_OWNER_USER_ID\}/);

  assert.match(blocks.spite, /spite-realtime-migrate: \{ condition: service_completed_successfully \}/);
  assert.match(blocks.spite, /spite-ownership-migrate: \{ condition: service_completed_successfully \}/);
  assert.match(blocks['spite-realtime'], /spite-realtime-migrate: \{ condition: service_completed_successfully \}/);
  assert.match(blocks['spite-realtime'], /spite-ownership-migrate: \{ condition: service_completed_successfully \}/);

  const publicLines = publicEnvLines(`${compose}\n${read('nexoclip-app/services/spite/Dockerfile')}\n${read('nexoclip-app/Dockerfile')}`);
  for (const line of publicLines) {
    assert.doesNotMatch(line, /(DATABASE_URL|postgres(?:ql)?:\/\/)/i, `public build/env line must not contain DB credentials: ${line}`);
  }

  for (const volume of ['postgres-data', 'redis-data', 'ai-clip-output', 'caddy-data', 'caddy-config']) {
    assert.match(compose, new RegExp(`^  ${volume}:`, 'm'));
  }
});

test('Realtime dependency contract is pinned in app and spite manifests', () => {
  const spitePackage = readJson('nexoclip-app/services/spite/package.json');
  const appPackage = readJson('nexoclip-app/package.json');

  const providerVersion = spitePackage.dependencies['@hocuspocus/provider'];
  const serverVersion = spitePackage.dependencies['@hocuspocus/server'];

  assert.equal(typeof providerVersion, 'string');
  assert.equal(typeof serverVersion, 'string');
  assert.match(providerVersion, /^4\.6\./, '@hocuspocus/provider must stay on 4.6.x');
  assert.match(serverVersion, /^4\.6\./, '@hocuspocus/server must stay on 4.6.x');
  assert.equal(providerVersion, serverVersion, 'provider/server pins must match exactly');
  assert.equal(spitePackage.dependencies.yjs, '13.6.32');
  assert.equal(spitePackage.dependencies['y-protocols'], '1.0.7');
  assert.equal(spitePackage.dependencies.jose, '6.2.12');
  assert.equal(appPackage.dependencies.jose, '6.2.12');
});
