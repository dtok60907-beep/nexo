import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const toolbar = read('services/spite/components/canvas/left-toolbar.tsx');
const imageNode = read('services/spite/components/canvas/nodes/image-node.tsx');
const videoNode = read('services/spite/components/canvas/nodes/video-node.tsx');
const assetsRoute = read('app/api/assets/route.js');
const downloadRoute = read('app/api/assets/[assetId]/download/route.js');
const caddy = read('../Caddyfile');

test('Canvas workspace assets route reaches the main app before the Spite catch-all', () => {
  const alias = caddy.indexOf('handle /spite/api/workspace-assets*');
  const spite = caddy.indexOf('handle /spite*');
  assert.notEqual(alias, -1);
  assert.ok(alias < spite);
  assert.match(caddy.slice(alias, spite), /reverse_proxy nexoclip-app:3000/);
});

test('Canvas assets use the generation default workspace without sessionStorage coupling', () => {
  assert.doesNotMatch(toolbar, /sessionStorage\.getItem\('nexoclip_workspace_id'\)/);
  assert.match(toolbar, /withBasePath\('\/api\/workspace-assets'\)/);
  assert.match(assetsRoute, /getDefaultWorkspace/);
});

test('asset panel refreshes on completion without aggressive polling', () => {
  assert.match(imageNode, /asset-status-changed/);
  assert.match(videoNode, /asset-status-changed/);
  assert.doesNotMatch(toolbar, /refreshInterval: 3000/);
});

test('asset downloads verify ownership then redirect directly to short-lived R2 URLs', () => {
  assert.match(downloadRoute, /status: 302/);
  assert.doesNotMatch(downloadRoute, /status: 307/);
  assert.match(downloadRoute, /Location: result\.download\.url/);
  assert.match(downloadRoute, /private, max-age=300/);
  assert.doesNotMatch(downloadRoute, /private, no-store/);
  assert.match(downloadRoute, /'Vary': 'Cookie'/);
  assert.doesNotMatch(downloadRoute, /createStorage\(\)\.get/);
});
