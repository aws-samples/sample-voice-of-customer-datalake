/**
 * @fileoverview The current workspace's trial (7.71.00; docs/multi-workspace.md "Trial workspaces") and the role
 * playbook suggested to the caller, as `GET /me/workspaces/current` answers them: a plain store, so the pages that
 * hold a control back while a trial is paused (the plugins card, a form's Live switch, the builder's Publish) read it
 * without a query of their own. The trial banner (TrialBanner.tsx, in the layout) keeps it in step with the answer;
 * outside a workspace it is empty.
 *
 * The server refuses the same things anyway (409 `trial_paused`): this only says why before anyone tries.
 *
 * @module workspace/currentTrial
 */
import { create } from 'zustand'
import type { PlaybookRole } from '../api/onboardingApi'
import type { TrialSummary } from '../api/workspacesApi'

interface TrialState {
  readonly trial: TrialSummary | null
  readonly playbook: PlaybookRole | null
}

const useTrialStore = create<TrialState>(() => ({ trial: null, playbook: null }))

/** Keep the store in step with the server's answer for the current workspace (null: none, or outside one). */
export function setCurrentTrial(state: TrialState): void {
  useTrialStore.setState(state)
}

/** The current workspace's trial, or null for a workspace that is no trial (or none). */
export function useCurrentTrial(): TrialSummary | null {
  return useTrialStore((state) => state.trial)
}

/** Whether `trial` is paused and not converted (lambda/shared/trial_state.py `is_paused`). */
export function isTrialPaused(trial: TrialSummary | null): boolean {
  return trial !== null && trial.paused_at !== null && trial.converted_at === null
}

/** Whether the current workspace is a paused trial: its plugins and forms stay off until a platform admin acts. */
export function useTrialPaused(): boolean {
  return useTrialStore((state) => isTrialPaused(state.trial))
}

/** The role playbook the admin who added the caller suggested, or null. */
export function useSuggestedPlaybook(): PlaybookRole | null {
  return useTrialStore((state) => state.playbook)
}
