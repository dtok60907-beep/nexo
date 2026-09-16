import { SESSION_COOKIE } from '../../../../src/lib/auth/session.js';
import { resolveTenantContext } from '../../../../src/services/tenantContext.js';
import { getCurrentSession } from '../../../../src/services/authService.js';
import { getDefaultWorkspace } from '../../../../src/services/workspaceService.js';
import { deleteWorkspaceAsset } from '../../../../src/services/assetService.js';

function errorResponse(error) {
  const status = error.status || (error.message === 'Authentication required' ? 401 : error.message === 'Workspace access denied' ? 403 : 400);
  return Response.json({ error: error.message }, { status });
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
  const deleteAsset = deps.deleteWorkspaceAsset || deleteWorkspaceAsset;
  return async function DELETE(request, { params }) {
    try {
      const tenant = await resolveTenant({ token: request.cookies.get(SESSION_COOKIE)?.value });
      const { assetId } = await params;
      const asset = await deleteAsset(tenant.workspace.id, assetId);
      if (!asset) return Response.json({ error: 'Asset not found' }, { status: 404 });
      return Response.json({ success: true });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const DELETE = createAssetDeleteHandler();
