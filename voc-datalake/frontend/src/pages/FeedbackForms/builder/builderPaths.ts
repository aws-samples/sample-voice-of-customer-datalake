/**
 * @fileoverview The Feedback Forms pages' addresses (UX §2.1, §3.1), as paths the page reads itself:
 *
 * - `/feedback-forms`: the list;
 * - `/feedback-forms/new[?template=<id>]`: the template picker (a template's preview on narrow screens);
 * - `/feedback-forms/new/<tab>[/…]`: an unsaved new form in the builder (a template or an AI draft), until its first
 *   Save replaces `new` with the form's id;
 * - `/feedback-forms/<id>/<tab>[/…]`: the builder; `/feedback-forms/<id>` alone opens Results for a Live form with
 *   responses, Questions otherwise;
 * - `/feedback-forms/<id>/preview`: sent on to the builder's Questions tab; the preview window
 *   (preview/previewChannel.ts) is the full-size preview.
 *
 * Inside a tab: `/questions/<qid>`, `/questions/end/<eid>`, `/questions/welcome`; `/languages/<lng>`;
 * `/results/responses[/<responseId>]`.
 *
 * @module pages/FeedbackForms/builder/builderPaths
 */

export const BUILDER_TABS = ['questions', 'flow', 'languages', 'hidden-fields', 'test', 'share', 'results', 'settings'] as const
export type BuilderTab = (typeof BUILDER_TABS)[number]

const isTab = (value: string | undefined): value is BuilderTab => BUILDER_TABS.some((tab) => tab === value)

const NEW_FORM = 'new'

export type FormsPlace =
  | { readonly kind: 'list' }
  | { readonly kind: 'picker'; readonly template: string | null }
  /** `formId` null: the unsaved new form; `tab` null: the form's own default tab (decided once it is read). */
  | { readonly kind: 'builder'; readonly formId: string | null; readonly tab: BuilderTab | null; readonly rest: readonly string[] }
  /** A full-screen preview's address: the page sends it on to the builder. */
  | { readonly kind: 'preview'; readonly formId: string }

/** Where the page is, from the part of the path after `/feedback-forms/` and the query. */
export function parseFormsPath(splat: string, search: string): FormsPlace {
  const segments = splat.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment))
  const [first, second, ...rest] = segments
  if (first === undefined) return { kind: 'list' }
  if (first === NEW_FORM && second === undefined) return { kind: 'picker', template: new URLSearchParams(search).get('template') }
  if (first !== NEW_FORM && second === 'preview') return { kind: 'preview', formId: first }
  const formId = first === NEW_FORM ? null : first
  return { kind: 'builder', formId, tab: isTab(second) ? second : null, rest: isTab(second) ? rest : [] }
}

/** The path of a builder tab (and what is open in it) for `formId` (null: the unsaved new form). */
export function builderPath(formId: string | null, tab: BuilderTab, ...rest: readonly string[]): string {
  const ref = formId === null ? NEW_FORM : encodeURIComponent(formId)
  const tail = rest.map((segment) => `/${encodeURIComponent(segment)}`).join('')
  return `/feedback-forms/${ref}/${tab}${tail}`
}

/** The card a Questions path selects (null: none). */
export function selectedCard(rest: readonly string[]): { readonly kind: 'question' | 'ending' | 'welcome'; readonly id: string } | null {
  const [first, second] = rest
  if (first === undefined) return null
  if (first === 'welcome') return { kind: 'welcome', id: 'welcome' }
  if (first === 'end') return second === undefined ? null : { kind: 'ending', id: second }
  return { kind: 'question', id: first }
}

export const pickerPath = (template?: string): string =>
  (template === undefined ? `/feedback-forms/${NEW_FORM}` : `/feedback-forms/${NEW_FORM}?${new URLSearchParams({ template }).toString()}`)

export const FORMS_LIST_PATH = '/feedback-forms'
