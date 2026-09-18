import { NextResponse } from 'next/server.js';
import { SESSION_COOKIE } from '../../../../src/lib/auth/session.js';
import { getCurrentSession } from '../../../../src/services/authService.js';
import { getDefaultWorkspace } from '../../../../src/services/workspaceService.js';
import { resolveTenantContext } from '../../../../src/services/tenantContext.js';
import { importWorkspaceAsset } from '../../../../src/services/assetService.js';

export function createAssetImportHandler({
  getSession = async (request) => getCurrentSession(request.cookies?.get?.(SESSION_COOKIE)?.value),
  getWorkspace = getDefaultWorkspace,
  resolveTenant = resolveTenantContext,
  importAsset = importWorkspaceAsset,
} = {}) {
  return async function POST(request) {
    try {
      const session = await getSession(request);
      if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
      const workspace = await getWorkspace(session.user_id);
      if (!workspace) return NextResponse.json({ error: 'Workspace access denied' }, { status: 403 });
      const tenant = await resolveTenant({ token: request.cookies?.get?.(SESSION_COOKIE)?.value, workspaceId: workspace.id });
      const file = (await request.formData()).get('file');
      if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
        return NextResponse.json({ error: 'Only image files can be imported' }, { status: 400 });
      }
      const filename = typeof file.name === 'string' && file.name.trim() ? file.name : 'canvas-image';
      const result = await importAsset(tenant.workspace.id, {
        filename,
        contentType: file.type,
        body: Buffer.from(await file.arrayBuffer()),
      });
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      const status = Number(error?.status) || 400;
      return NextResponse.json({ error: status >= 500 ? 'Image import failed' : error.message }, { status });
    }
  };
}

export const POST = createAssetImportHandler();
