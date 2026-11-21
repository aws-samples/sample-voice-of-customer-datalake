/**
 * @fileoverview A new trial's starter pack, applied by the platform console in the trial it just created (7.71.00;
 * docs/multi-workspace.md "Trial workspaces"): each one an ordinary create through the existing route, with the
 * admin's own credentials, in that workspace (`X-Workspace-Id` names it: api/baseUrl.ts `WorkspaceTarget`), audited by
 * its own route. The creator is the trial's admin, so nothing here needs more than that.
 *
 * - a member: `POST /me/workspaces/current/members` `{email, role, playbook?}` (an email with no account gets one, and
 *   Cognito emails its temporary password);
 * - a form from a template: `POST /feedback-forms`, Off (publishing is the admin's later choice);
 * - the sample categories: `PUT /settings/categories`.
 *
 * @module pages/Settings/trial/trialPackApi
 */
import { fetchApi } from '../../../api/client'
import { post, put } from '../../../api/requestKit'
import type { PlaybookRole } from '../../../api/onboardingApi'
import type { WorkspaceRole } from '../../../api/workspacesApi'
import type { FormV2 } from '../../FeedbackForms/model/formsV2'
import { toWireForm } from '../../FeedbackForms/model/formsV2Schema'

/** One person of the invite list. */
export interface Invitee {
  readonly email: string
  readonly role: WorkspaceRole
  readonly playbook: PlaybookRole | null
}

/** A sample category as `PUT /settings/categories` takes it (schemas/trial-pack.json). */
export interface StarterCategory {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly subcategories: readonly { readonly id: string; readonly name: string; readonly description: string }[]
}

export const trialPackApi = {
  addMember: (workspaceId: string, invitee: Invitee): Promise<unknown> =>
    fetchApi<unknown>('/me/workspaces/current/members', post({
      email: invitee.email, role: invitee.role, ...(invitee.playbook === null ? {} : { playbook: invitee.playbook }),
    }), { workspaceId }),
  createForm: (workspaceId: string, form: FormV2): Promise<unknown> =>
    fetchApi<unknown>('/feedback-forms', post({ ...toWireForm(form), enabled: false }), { workspaceId }),
  saveCategories: (workspaceId: string, categories: readonly StarterCategory[]): Promise<unknown> =>
    fetchApi<unknown>('/settings/categories', put({ categories }), { workspaceId }),
}
