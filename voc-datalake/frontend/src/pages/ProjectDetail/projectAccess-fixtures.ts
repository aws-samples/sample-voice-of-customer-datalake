/**
 * `project.access` values as the server returns them for the two roles the
 * per-button gating distinguishes. Shared by the tab specs so each file does not
 * restate the four-field object.
 */
import type { ProjectAccess } from '../../api/projectTypes'

/** A viewer member of a private project: may read, may not change anything. */
export const VIEWER_ACCESS: ProjectAccess = { role: 'viewer', can_view: true, can_edit: false, can_manage: false }

/** An editor member: may change content, may not manage sharing. */
export const EDITOR_ACCESS: ProjectAccess = { role: 'editor', can_view: true, can_edit: true, can_manage: false }
