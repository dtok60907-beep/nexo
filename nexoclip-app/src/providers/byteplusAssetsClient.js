import { createHash, createHmac } from 'node:crypto';

const SERVICE = 'ark';
const VERSION = '2024-01-01';
const SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';
const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const PENDING_STATUSES = new Set(['Processing', 'Queued', 'Pending']);
const TRANSIENT_ERROR_CODES = new Set([
  'InternalError',
  'InternalServiceError',
  'RateLimitExceeded',
  'RequestLimitExceeded',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'Throttling',
  'ThrottlingException',
  'TooManyRequests',
  'TooManyRequestsException',
]);

export class BytePlusAssetsError extends Error {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = 'BytePlusAssetsError';
    this.provider = 'byteplus';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function formatDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signedRequest({ accessKeyId, secretAccessKey, region, action, body, date }) {
  const host = `ark.${region}.byteplusapi.com`;
  const query = `Action=${action}&Version=${VERSION}`;
  const bodyHash = sha256(body);
  const canonicalHeaders = [
    'content-type:application/json',
    `host:${host}`,
    `x-content-sha256:${bodyHash}`,
    `x-date:${date}`,
    '',
  ].join('\n');
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, SIGNED_HEADERS, bodyHash].join('\n');
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, day), region), SERVICE), 'request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    url: `https://${host}/?${query}`,
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      'X-Content-Sha256': bodyHash,
      'X-Date': date,
      Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    },
  };
}

function unavailableError(status = 503) {
  return new BytePlusAssetsError('BytePlus Assets API is temporarily unavailable.', {
    code: 'BYTEPLUS_ASSETS_UNAVAILABLE',
    status,
    retryable: true,
  });
}

function requestError(status) {
  return new BytePlusAssetsError('BytePlus Assets API request failed.', {
    code: 'BYTEPLUS_ASSETS_REQUEST_FAILED',
    status,
  });
}

function invalidResponseError() {
  return new BytePlusAssetsError('BytePlus Assets API returned an invalid response.', {
    code: 'BYTEPLUS_ASSETS_INVALID_RESPONSE',
    status: 502,
  });
}

function invalidInputError() {
  return new BytePlusAssetsError('BytePlus Assets API input is invalid.', {
    code: 'BYTEPLUS_ASSETS_INVALID_INPUT',
    status: 400,
  });
}

function requireNonEmptyString(value) {
  if (typeof value !== 'string' || !value.trim()) throw invalidInputError();
}

export function mapBytePlusAssetStatus(payload) {
  const result = payload?.Result || payload || {};
  if (result.Status === 'Active') return { status: 'active' };
  if (result.Status === 'Failed') {
    return {
      status: 'failed',
      error: {
        code: 'BYTEPLUS_ASSET_PROCESSING_FAILED',
        message: 'BytePlus could not process this asset.',
      },
    };
  }
  if (PENDING_STATUSES.has(result.Status)) return { status: 'processing' };
  throw invalidResponseError();
}

export function createBytePlusAssetsClient({ env = process.env, fetchFn = globalThis.fetch, now = () => new Date() } = {}) {
  const accessKeyId = env.BYTEPLUS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.BYTEPLUS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new BytePlusAssetsError('BytePlus Assets API is not configured.', {
      code: 'BYTEPLUS_ASSETS_NOT_CONFIGURED',
      status: 503,
    });
  }

  const projectName = env.BYTEPLUS_PROJECT_NAME?.trim() || 'default';
  const region = env.BYTEPLUS_REGION?.trim() || 'ap-southeast-1';
  const requestTimeoutMs = Math.max(1, Number(env.BYTEPLUS_ASSETS_TIMEOUT_MS) || 15_000);

  async function request(action, body) {
    const payload = JSON.stringify(body);
    const signed = signedRequest({
      accessKeyId,
      secretAccessKey,
      region,
      action,
      body: payload,
      date: formatDate(now()),
    });
    let response;
    try {
      response = await fetchFn(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: payload,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw unavailableError();
    }
    if (!response.ok) {
      if (TRANSIENT_STATUSES.has(response.status) || response.status >= 500) {
        throw unavailableError(response.status);
      }
      throw requestError(response.status);
    }
    let responseBody;
    try {
      responseBody = await response.json();
    } catch {
      throw invalidResponseError();
    }
    const providerError = responseBody?.ResponseMetadata?.Error;
    if (providerError) {
      if (TRANSIENT_ERROR_CODES.has(providerError.Code)) throw unavailableError();
      throw requestError(400);
    }
    if (!responseBody?.Result || typeof responseBody.Result !== 'object') throw invalidResponseError();
    return responseBody.Result;
  }

  return {
    createAssetGroup({ name, description, clientToken } = {}) {
      requireNonEmptyString(name);
      requireNonEmptyString(clientToken);
      return request('CreateAssetGroup', {
        Name: name,
        ...(description ? { Description: description } : {}),
        GroupType: 'AIGC',
        ProjectName: projectName,
        ClientToken: clientToken,
      });
    },
    createAsset({ groupId, url, name, clientToken } = {}) {
      requireNonEmptyString(groupId);
      requireNonEmptyString(url);
      requireNonEmptyString(name);
      requireNonEmptyString(clientToken);
      return request('CreateAsset', {
        GroupId: groupId,
        URL: url,
        Name: name,
        AssetType: 'Image',
        Moderation: { Strategy: 'Skip' },
        ProjectName: projectName,
        ClientToken: clientToken,
      });
    },
    getAsset({ assetId } = {}) {
      requireNonEmptyString(assetId);
      return request('GetAsset', { Id: assetId, ProjectName: projectName });
    },
  };
}
