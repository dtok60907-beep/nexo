import { createHash, createHmac } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function encodePath(value) {
  return String(value).split('/').map((part) => (
    encodeURIComponent(part).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  )).join('/');
}

function formatDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function objectKey(value, bucket, accountId) {
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== `${accountId}.r2.cloudflarestorage.com`) throw new Error('Invalid R2 download URL');
  const [encodedBucket, ...parts] = url.pathname.slice(1).split('/');
  if (decodeURIComponent(encodedBucket) !== bucket || !parts.length) throw new Error('Invalid R2 download URL');
  return parts.map(decodeURIComponent).join('/');
}

export function createR2Client({
  accountId = required('R2_ACCOUNT_ID'),
  accessKeyId = required('R2_ACCESS_KEY_ID'),
  secretAccessKey = required('R2_SECRET_ACCESS_KEY'),
} = {}) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export class R2ObjectStorage {
  constructor({
    bucket = required('R2_BUCKET'),
    publicUrl = required('R2_PUBLIC_URL'),
    accountId = process.env.R2_ACCOUNT_ID,
    accessKeyId = process.env.R2_ACCESS_KEY_ID,
    secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
    now = () => new Date(),
    client,
  } = {}) {
    this.bucket = bucket;
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.accountId = accountId;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.now = now;
    this.client = client || createR2Client({ accountId, accessKeyId, secretAccessKey });
  }

  async put(key, body, contentType) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return `${this.publicUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async createDownloadUrl({ key, expiresInSeconds = 900 }) {
    if (!this.accountId || !this.accessKeyId || !this.secretAccessKey) throw new Error('R2 signing credentials are required');
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
      throw new Error('R2 download URL expiry is invalid');
    }
    const date = formatDate(this.now());
    const day = date.slice(0, 8);
    const host = `${this.accountId}.r2.cloudflarestorage.com`;
    const scope = `${day}/auto/s3/aws4_request`;
    const pathname = `/${encodePath(this.bucket)}/${encodePath(key)}`;
    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': date,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': 'host',
    });
    query.sort();
    const canonicalRequest = ['GET', pathname, query.toString(), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    query.set('X-Amz-Signature', signature);
    return { method: 'GET', url: `https://${host}${pathname}?${query}` };
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async get(key) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey(key, this.bucket, this.accountId) }));
    const bytes = typeof response.Body?.transformToByteArray === 'function'
      ? await response.Body.transformToByteArray()
      : response.Body;
    return { body: Buffer.from(bytes), contentType: response.ContentType };
  }
}
