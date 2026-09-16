import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function encode(value) {
  return Buffer.from(String(value)).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString();
}

function signature(secret, operation, key, expires) {
  return createHmac('sha256', secret).update(`${operation}:${key}:${expires}`).digest('base64url');
}

function parseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'local:') throw new Error('Invalid storage URL');
  const operation = url.hostname;
  const key = decode(url.searchParams.get('key') || '');
  const expires = Number(url.searchParams.get('expires'));
  const provided = url.searchParams.get('signature') || '';
  return { operation, key, expires, provided };
}

export class LocalObjectStorage {
  constructor({ root, secret }) {
    if (!root || !secret) throw new Error('Local object storage root and secret are required');
    this.root = root;
    this.secret = secret;
  }

  #url(operation, key, expiresInSeconds) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signatureValue = signature(this.secret, operation, key, expires);
    return `local://${operation}?key=${encode(key)}&expires=${expires}&signature=${signatureValue}`;
  }

  #authorize(value, operation) {
    const parsed = parseUrl(value);
    if (parsed.operation !== operation) throw new Error('Invalid storage URL');
    if (!parsed.key || !Number.isFinite(parsed.expires) || parsed.expires < Math.floor(Date.now() / 1000)) {
      throw new Error('Storage URL expired');
    }
    const expected = signature(this.secret, operation, parsed.key, parsed.expires);
    if (parsed.provided.length !== expected.length || !timingSafeEqual(Buffer.from(parsed.provided), Buffer.from(expected))) {
      throw new Error('Invalid storage URL signature');
    }
    return parsed;
  }

  async createUploadUrl({ key, contentType, expiresInSeconds = 900 }) {
    return { method: 'PUT', url: this.#url('upload', key, expiresInSeconds), contentType };
  }

  async createDownloadUrl({ key, expiresInSeconds = 900 }) {
    return { method: 'GET', url: this.#url('download', key, expiresInSeconds) };
  }

  async put(url, body, contentType) {
    const { key } = this.#authorize(url, 'upload');
    const root = path.resolve(this.root);
    const target = path.resolve(root, key);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage key');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    await writeFile(`${target}.metadata`, JSON.stringify({ contentType }));
  }

  async delete(key) {
    const root = path.resolve(this.root);
    const target = path.resolve(root, key);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage key');
    await Promise.all([rm(target, { force: true }), rm(`${target}.metadata`, { force: true })]);
  }

  async get(url) {
    const { key } = this.#authorize(url, 'download');
    const root = path.resolve(this.root);
    const target = path.resolve(root, key);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage key');
    return {
      body: await readFile(target),
      contentType: JSON.parse(await readFile(`${target}.metadata`, 'utf8')).contentType,
    };
  }
}
