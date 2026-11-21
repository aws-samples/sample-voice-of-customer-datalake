/**
 * @fileoverview The forms list's toolbar (UX §14.2, past six forms): a name search, the state filter (All, Live, Off,
 * Test link on) and the sort (Newest, the list's own order; Last response and Responses, from the list's stats; Name).
 * A form without a response time sorts after those with one.
 *
 * @module pages/FeedbackForms/formsListFilter
 */
import type { FeedbackForm } from '../../api/types'
import type { FormStats } from '../../api/feedbackFormStatsSchema'
import { parseStoredForm } from '../../api/feedbackFormsV2Api'

/** The toolbar shows from this many forms of the person's own. */
export const TOOLBAR_FROM = 7

export const STATE_FILTERS = ['all', 'live', 'off', 'test'] as const
export type StateFilter = (typeof STATE_FILTERS)[number]

export const SORTS = ['newest', 'lastResponse', 'name', 'responses'] as const
export type FormsSort = (typeof SORTS)[number]

export interface FormsQuery {
  readonly search: string
  readonly state: StateFilter
  readonly sort: FormsSort
}

export const ALL_FORMS: FormsQuery = { search: '', state: 'all', sort: 'newest' }

export const narrowsForms = (query: FormsQuery): boolean => query.search.trim() !== '' || query.state !== 'all'

const testLinkOn = (form: FeedbackForm): boolean => parseStoredForm(form)?.form.settings.test.link_enabled === true

function matchesState(form: FeedbackForm, state: StateFilter): boolean {
  switch (state) {
    case 'all': return true
    case 'live': return form.enabled
    case 'off': return !form.enabled
    case 'test': return testLinkOn(form)
  }
}

/** The forms the toolbar shows, in its order (`stats`: the list's per-form stats, absent ones count 0 responses). */
export function visibleForms(forms: readonly FeedbackForm[], query: FormsQuery, stats: Readonly<Record<string, FormStats>> | null,
  language: string): FeedbackForm[] {
  const needle = query.search.trim().toLocaleLowerCase(language)
  const kept = forms.filter((form) => matchesState(form, query.state) && (needle === '' || form.name.toLocaleLowerCase(language).includes(needle)))
  if (query.sort === 'name') return [...kept].sort((a, b) => a.name.localeCompare(b.name, language, { sensitivity: 'base' }))
  if (query.sort === 'lastResponse') {
    const last = (form: FeedbackForm) => stats?.[form.form_id]?.last_response_at ?? ''
    return [...kept].sort((a, b) => last(b).localeCompare(last(a)))
  }
  if (query.sort === 'responses') {
    const responses = (form: FeedbackForm) => stats?.[form.form_id]?.total_submissions ?? 0
    return [...kept].sort((a, b) => responses(b) - responses(a))
  }
  return kept
}
