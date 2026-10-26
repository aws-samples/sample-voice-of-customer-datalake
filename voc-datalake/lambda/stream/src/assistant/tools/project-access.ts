/**
 * The caller's per-project access, as the Projects API reports it.
 *
 * Every project read (`GET /projects/{id}` → `project.access`, the internal
 * chat-context read → top-level `access`) carries what the signed-in user may
 * do on that project: `role` plus `can_view` / `can_edit` / `can_manage`
 * (`lambda/shared/project_access.py`). The assistant keeps what it learned
 * during a run in a ledger on the run context so that:
 *   - the runtime can drop the project write tools when the project on screen
 *     is view-only (the preload reads it before the first model turn), and
 *   - a project write proposed for a project the user cannot edit is refused
 *     before an approval card is ever shown (defence in depth — the REST API
 *     still enforces the permission when an approved write executes).
 *
 * Only what a read REPORTED is known; an unread project is "unknown", never
 * "read-only", so the REST API stays the authority.
 */
import { z } from 'zod';

export interface ProjectAccessSummary {
  /** owner | admin | editor | viewer, or null when the API reports none. */
  role: string | null;
  can_edit: boolean;
  can_manage: boolean;
}

const accessSchema = z.object({
  role: z.string().nullish().catch(null),
  can_edit: z.boolean(),
  can_manage: z.boolean(),
}).loose();

/** The compact access summary, or undefined when the value is not a readable access record. */
export function parseProjectAccess(value: unknown): ProjectAccessSummary | undefined {
  const parsed = accessSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { role: parsed.data.role ?? null, can_edit: parsed.data.can_edit, can_manage: parsed.data.can_manage };
}

/** Per-run record of the access each project read reported (latest read wins). */
export class ProjectAccessLedger {
  private readonly byProject = new Map<string, ProjectAccessSummary>();

  record(projectId: string, access: ProjectAccessSummary | undefined): void {
    if (access) this.byProject.set(projectId, access);
  }

  get(projectId: string): ProjectAccessSummary | undefined {
    return this.byProject.get(projectId);
  }

  /** True only when a read REPORTED that the caller cannot edit the project. */
  isReadOnly(projectId: string | undefined): boolean {
    // Stryker disable next-line ConditionalExpression: record() keys the map by string only, so get(undefined) is always undefined; the guard is for the type checker
    return projectId !== undefined && this.byProject.get(projectId)?.can_edit === false;
  }
}
