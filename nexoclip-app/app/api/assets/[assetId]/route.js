import { SESSION_COOKIE } from '../../../../src/lib/auth/session.js';
import { resolveTenantContext } from '../../../../src/services/tenantContext.js';
import { getCurrentSession } from '../../../../src/services/authService.js';
import { getDefaultWorkspace } from '../../../../src/services/workspaceService.js';
import { createStorage } from '../../../../src/services/assetService.js';
import { getPool } from '../../../../src/db/pool.js';
import { createBytePlusAssetsClient } from '../../../../src/providers/byteplusAssetsClient.js';
import { deleteTrustedWorkspaceAsset } from '../../../../src/services/unifiedAssetDeletionService.js';

function errorResponse(error) {
  const status = error.status || (error.message === 'Authentication required' ? 401 : error.message === 'Workspace access denied' ? 403 : 400);
  return Response.json({
    error: error.code ? { code: error.code, message: error.message, retryable: Boolean(error.retryable) } : { message: error.message },
  }, { status });
}

function deleteWorkspaceAsset(workspaceId, localAssetId, cookie) {
  const provider = { deleteAsset: input => createBytePlusAssetsClient().deleteAsset(input) };
  return deleteTrustedWorkspaceAsset({
    workspaceId, localAssetId, pool: getPool(), storage: createStorage(), bytePlusClient: provider,
    cleanupCanvasReferences: async () => {
      const spiteUrl = process.env.NEXT_PUBLIC_SPITE_URL?.trim().replace(/\/$/, '');
      if (!spiteUrl || !/^https?:\/\//.test(spiteUrl)) return { complete: false };
      const response = await fetch(`${spiteUrl}/api/assets/${encodeURIComponent(localAssetId)}?cleanup=1`, {
        method: 'DELETE', headers: { cookie: cookie || '' },
      });
      return { complete: response.ok };
    },
    configuredProjectName: process.env.BYTEPLUS_PROJECT_NAME?.trim() || 'default',
  });
}

async function resolveDefaultTenant({ token }) {
  const session = await getCurrentSession(token);
  if (!session) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const workspace = await getDefaultWorkspace(session.user_id);
  if (!workspace) throw Object.assign(new Error('Workspace access denied'), { status: 403 });
  return resolveTenantContext({ token, workspaceId: workspace.id });
}

export function createAssetDeleteHandler(deps = {}) {
  const resolveTenant = deps.resolveTenantContext || resolveDefaultTenant;
  const injectedDeleteAsset = deps.deleteWorkspaceAsset;
  const deleteAsset = injectedDeleteAsset || deleteWorkspaceAsset;
  return async function DELETE(request, { params }) {
    try {
      const tenant = await resolveTenant({ token: request.cookies.get(SESSION_COOKIE)?.value });
      const { assetId } = await params;
      const asset = injectedDeleteAsset
        ? await deleteAsset(tenant.workspace.id, assetId)
        : await deleteAsset(tenant.workspace.id, assetId, request.headers?.get?.('cookie'));
      if (!asset) return Response.json({ error: 'Asset not found' }, { status: 404 });
      return Response.json({ success: true });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const DELETE = createAssetDeleteHandler();
