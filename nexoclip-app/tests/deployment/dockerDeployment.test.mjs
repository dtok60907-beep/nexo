import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

function serviceBlocks(compose) {
  const servicesStart = compose.indexOf('services:\n') + 'services:\n'.length;
  const remainder = compose.slice(servicesStart);
  const servicesEnd = remainder.search(/^networks:|^volumes:/m);
  const services = remainder.slice(0, servicesEnd === -1 ? undefined : servicesEnd);
  const blocks = new Map();
  const matches = [...services.matchAll(/^  ([a-z][\w-]+):\n/gm)];

  for (const [index, match] of matches.entries()) {
    blocks.set(match[1], services.slice(match.index, matches[index + 1]?.index));
  }

  return blocks;
}

const assetVars = {
  BYTEPLUS_ACCESS_KEY_ID: '${BYTEPLUS_ACCESS_KEY_ID}',
  BYTEPLUS_SECRET_ACCESS_KEY: '${BYTEPLUS_SECRET_ACCESS_KEY}',
  BYTEPLUS_PROJECT_NAME: '${BYTEPLUS_PROJECT_NAME:-default}',
  BYTEPLUS_REGION: '${BYTEPLUS_REGION:-ap-southeast-1}',
};

const mainStorageVars = {
  R2_BUCKET: '${R2_BUCKET_NAME}',
  R2_PUBLIC_URL: '${R2_PUBLIC_URL}',
  R2_ACCOUNT_ID: '${R2_ACCOUNT_ID}',
  R2_ACCESS_KEY_ID: '${R2_ACCESS_KEY_ID}',
  R2_SECRET_ACCESS_KEY: '${R2_SECRET_ACCESS_KEY}',
};

const endpointVars = [
  'BYTEPLUS_SEEDANCE_2_ENDPOINT',
  'BYTEPLUS_SEEDANCE_2_5_ENDPOINT',
  'BYTEPLUS_SEEDREAM_5_ENDPOINT',
];

const deployments = [
  { path: 'docker-compose.yml', targets: ['nexoclip-app', 'nexoclip-video-worker'], workers: ['nexoclip-image-worker', 'nexoclip-video-worker'] },
  { path: 'docker-compose.prod.yml', targets: ['nexoclip', 'video-worker'], workers: ['image-worker', 'video-worker'] },
];

test('documents server-only BytePlus Assets configuration without browser exposure', () => {
  for (const path of ['.env.example', '.env.production.example', 'nexoclip-app/.env.example']) {
    const example = read(path);

    assert.match(example, /^BYTEPLUS_ACCESS_KEY_ID=$/m, `${path} must document the access key without a value`);
    assert.match(example, /^BYTEPLUS_SECRET_ACCESS_KEY=$/m, `${path} must document the secret key without a value`);
    assert.match(example, /^BYTEPLUS_PROJECT_NAME=default$/m, `${path} must document the default project`);
    assert.match(example, /^BYTEPLUS_REGION=ap-southeast-1$/m, `${path} must document the default region`);
    assert.doesNotMatch(example, /^NEXT_PUBLIC_BYTEPLUS_/m, `${path} must not expose BytePlus configuration to the browser`);

    for (const name of endpointVars) {
      assert.match(example, new RegExp(`^${name}=`, 'm'), `${path} must preserve ${name}`);
    }
  }
});

test('wires BytePlus Assets configuration to the main app and video worker only', () => {
  for (const deployment of deployments) {
    const compose = read(deployment.path);
    const blocks = serviceBlocks(compose);

    for (const target of deployment.targets) {
      const block = blocks.get(target);
      assert.ok(block, `${deployment.path} must contain ${target}`);
      for (const [name, interpolation] of Object.entries(assetVars)) {
        assert.ok(
          block.split('\n').includes(`      ${name}: ${interpolation}`),
          `${target} must receive ${name} as ${interpolation}`,
        );
      }
    }

    const main = blocks.get(deployment.targets[0]);
    for (const [name, productionInterpolation] of Object.entries(mainStorageVars)) {
      const interpolation = deployment.path === 'docker-compose.yml'
        ? productionInterpolation.replace('}', ':-}')
        : productionInterpolation;
      assert.ok(
        main.split('\n').includes(`      ${name}: ${interpolation}`),
        `${deployment.targets[0]} must receive ${name} as ${interpolation}`,
      );
    }

    for (const [service, block] of blocks) {
      if (deployment.targets.includes(service)) continue;
      for (const name of Object.keys(assetVars)) {
        assert.doesNotMatch(block, new RegExp(`^      ${name}:`, 'm'), `${service} must not receive ${name}`);
      }
    }

    assert.doesNotMatch(compose, /NEXT_PUBLIC_BYTEPLUS_/, `${deployment.path} must keep BytePlus Assets configuration server-only`);

    for (const worker of deployment.workers) {
      const block = blocks.get(worker);
      const bucketInterpolation = deployment.path === 'docker-compose.yml'
        ? '${R2_BUCKET_NAME:-}'
        : '${R2_BUCKET_NAME}';
      assert.ok(
        block.split('\n').includes(`      R2_BUCKET: ${bucketInterpolation}`),
        `${worker} must write assets to the same R2 bucket as the main app`,
      );
      for (const name of endpointVars) {
        assert.match(block, new RegExp(`^      ${name}:`, 'm'), `${worker} must preserve ${name}`);
      }
    }
  }
});
