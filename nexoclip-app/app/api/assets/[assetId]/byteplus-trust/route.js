import { SESSION_COOKIE } from '../../../../../src/lib/auth/session.js';
import { getCurrentSession } from '../../../../../src/services/authService.js';
import {
  getBytePlusAssetTrust,
  startBytePlusAssetTrust,
} from '../../../../../src/services/byteplusAssetTrustService.js';
import { resolveTenantContext } from '../../../../../src/services/tenantContext.js';
import { getDefaultWorkspace } from '../../../../../src/services/workspaceService.js';

const safeErrors = {
  BYTEPLUS_ASSETS_NOT_CONFIGURED: ['BytePlus Assets API is not configured.', 503],
  BYTEPLUS_ASSETS_UNAVAILABLE: ['BytePlus Assets API is temporarily unavailable.', 503],
  BYTEPLUS_ASSETS_REQUEST_FAILED: ['BytePlus Assets API request failed.', 400],
  BYTEPLUS_ASSETS_INVALID_RESPONSE: ['BytePlus Assets API returned an invalid response.', 502],
  BYTEPLUS_ASSETS_INVALID_INPUT: ['BytePlus Assets API input is invalid.', 400],
  BYTEPLUS_ASSET_TYPE_UNSUPPORTED: ['Only image assets can be trusted for Seedance.', 400],
  BYTEPLUS_ASSET_SOURCE_UNAVAILABLE: ['Asset storage is not available to BytePlus.', 503],
  BYTEPLUS_ASSET_TRUST_FAILED: ['Unable to update trusted asset.', 502],
};

function errorResponse(error) {
  if (error.message === 'Authentication required') {
    return Response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } }, { status: 401 });
  }
  if (error.message === 'Workspace access denied') {
    return Response.json({ error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Workspace access denied' } }, { status: 403 });
  }
  const safe = safeErrors[error.code];
  if (safe) {
    return Response.json({ error: { code: error.code, message: safe[0] } }, { status: error.status || safe[1] });
  }
  return Response.json({
    error: { code: 'BYTEPLUS_ASSET_TRUST_FAILED', message: 'Unable to update trusted asset.' },
  }, { status: 500 });
}

async function resolveDefaultTenant({ token }) {
  const session = await getCurrentSession(token);
  if (!session) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const workspace = await getDefaultWorkspace(session.user_id);
  if (!workspace) throw Object.assign(new Error('Workspace access denied'), { status: 403 });
  return resolveTenantContext({ token, workspaceId: workspace.id });
}

export function createBytePlusAssetTrustHandlers(deps = {}) {
  const resolveTenant = deps.resolveTenantContext || resolveDefaultTenant;
  const trustService = deps.trustService || {
    getTrust: getBytePlusAssetTrust,
    startTrust: startBytePlusAssetTrust,
  };

  async function handle(operation, request, { params }) {
    try {
      const tenant = await resolveTenant({ token: request.cookies.get(SESSION_COOKIE)?.value });
      const { assetId } = await params;
      const state = await trustService[operation](tenant.workspace.id, assetId);
      if (!state) {
        return Response.json({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } }, { status: 404 });
      }
      return Response.json(state);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    GET: (request, context) => handle('getTrust', request, context),
    POST: (request, context) => handle('startTrust', request, context),
  };
}

const handlers = createBytePlusAssetTrustHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
