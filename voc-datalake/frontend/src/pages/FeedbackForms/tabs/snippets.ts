/**
 * @fileoverview The ready-to-copy links and code a form is shared with (UX §6, §9.4), built from its own public
 * address (`feedbackFormPublicUrl`): the link (with `hf_<id>={PLACEHOLDER}` for each hidden field and `lang=`, D4),
 * the iframe, the script embed and the in-app SDK call. Live | Test swaps the live link for the test link
 * (`test=<token>`, D2). Null when the configured endpoint cannot address the form (nothing to share yet).
 *
 * @module pages/FeedbackForms/tabs/snippets
 */
import { feedbackFormPublicUrl } from '../../../api/feedbackFormUrls'
import { stripTrailingSlashes } from '../../../api/baseUrl'
import type { FormLanguage, HiddenField } from '../model/formsV2'

export interface SnippetInput {
  readonly apiEndpoint: string
  readonly formId: string
  readonly formName: string
  readonly language: FormLanguage
  readonly hidden: readonly HiddenField[]
  /** The test token when the Test link is shown; null: the live link. */
  readonly testToken: string | null
}

/** `{USER_ID}` for `user_id`: the placeholder a developer replaces. */
const placeholderOf = (id: string): string => `{${id.toUpperCase()}}`

/** The form's link, live or test; with `withHidden`, every hidden field as `hf_<id>={…}` and the language. */
export function formLink(input: SnippetInput, withHidden: boolean): string | null {
  const base = feedbackFormPublicUrl(input.apiEndpoint, input.formId)
  if (base === null) return null
  const params = [
    ...(input.testToken === null ? [] : [`test=${encodeURIComponent(input.testToken)}`]),
    ...(withHidden ? input.hidden.map((field) => `hf_${field.id}=${placeholderOf(field.id)}`) : []),
    ...(withHidden ? [`lang=${input.language}`] : []),
  ]
  return params.length === 0 ? base : `${base}?${params.join('&')}`
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function iframeSnippet(input: SnippetInput): string | null {
  const link = formLink(input, false)
  if (link === null) return null
  return `<iframe\n  src="${link}"\n  style="width: 100%; min-height: 480px; border: none;"\n  title="${escapeAttribute(input.formName)}"\n></iframe>`
}

/** The `VoCFeedbackForm.init` call, with the language and the hidden fields' placeholders (and the test token). */
export function initSnippet(input: SnippetInput): string {
  const hidden = input.hidden.map((field) => `${field.id}: ${placeholderOf(field.id).slice(1, -1)}`).join(', ')
  const lines = [
    'VoCFeedbackForm.init({',
    "  container: '#voc-feedback-form',",
    `  apiEndpoint: '${stripTrailingSlashes(input.apiEndpoint)}',`,
    `  formId: '${input.formId}',`,
    `  language: '${input.language}',`,
    ...(input.hidden.length === 0 ? [] : [`  hidden: { ${hidden} },`]),
    ...(input.testToken === null ? [] : [`  test: '${input.testToken}',`]),
    '});',
  ]
  return lines.join('\n')
}
