/**
 * Default-subject preload: on a project page the project the user is looking at
 * is read before the first model turn and placed in a `<context>` data block
 * of the newest user message (never the system block: its text is user-authored,
 * see page-context.ts), so the assistant knows the project, its personas and its
 * documents without having to decide to call `get_project` first.
 *
 * It reuses the read-only `get_project` server tool (same Projects API call,
 * same caller claims, same summarisation and size cap), so it can never see
 * more than the user could. A failed read is not fatal: the prompt says the
 * project could not be preloaded and the model can still call the tool.
 *
 * The read also reports the caller's access; when it says `can_edit: false`
 * the run drops the project write tools (see run.ts / withoutProjectWrites).
 */
import type { AssistantRunContext, AssistantToolset } from '../types.js';

const PRELOAD_TOOL = 'get_project';

export type ProjectPreload =
  | { status: 'loaded'; summary: string; readOnly: boolean }
  | { status: 'unavailable' };

export async function preloadDefaultProject(
  toolset: AssistantToolset,
  ctx: AssistantRunContext,
): Promise<ProjectPreload | undefined> {
  const projectId = ctx.page.projectId;
  const tool = toolset.byName.get(PRELOAD_TOOL);
  if (!projectId || tool?.kind !== 'server') return undefined;
  try {
    // get_project records the caller's access in ctx.projectAccess as it reads.
    const result = await tool.execute({ project_id: projectId }, ctx);
    return { status: 'loaded', summary: result.content, readOnly: ctx.projectAccess.isReadOnly(projectId) };
  } catch (err) {
    console.warn(`Default project preload failed (${err instanceof Error ? err.name : 'unknown'})`);
    return { status: 'unavailable' };
  }
}
