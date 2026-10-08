/**
 * The one place the Project Detail page turns `project.access` into a UI decision.
 *
 * The SERVER is the boundary (`lambda/shared/project_access.py` gates every
 * route; a viewer's write gets 403 regardless of what this returns). This only
 * decides whether to show or disable the controls that would issue such a
 * write, so a viewer is not offered buttons that can only fail.
 */
import type { Project } from '../../api/projectTypes'

/**
 * Whether the caller may change this project.
 *
 * `access` is optional on the wire type. The Zod normaliser fills it (and fails
 * closed to `can_edit: false` when the server sent nothing usable), but a
 * `Project` built elsewhere — a test fixture, a mocked `projectsApi` that bypasses
 * the normaliser — may lack it. A missing `access` reads as editable, exactly the
 * condition `ReadOnlyBanner` has always used (`can_edit === false`), so the
 * banner and the per-button gates can never disagree about one project.
 */
export function canEditProject(project: Pick<Project, 'access'>): boolean {
  return project.access?.can_edit !== false
}
