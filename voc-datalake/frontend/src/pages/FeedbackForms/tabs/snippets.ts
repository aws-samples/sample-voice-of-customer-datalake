/**
 * @fileoverview The ready-to-copy links and code a form is shared with (UX §6, §9.4), built from its own public
 * address (`feedbackFormPublicUrl`): the link (with `hf_<id>={PLACEHOLDER}` for each hidden field and `lang=`, D4),
 * the iframe (with the resizer that grows it to the form's height), the script embed and the in-app SDK call. Live |
 * Test swaps the live link for the test link (`test=<token>`, D2). Null when the configured endpoint cannot address
 * the form (nothing to share yet).
 *
 * The script embed and the SDK load the widget from this app's own origin, `/widget/feedback-widget.js`: a static
 * file of the build (frontend/widgetAssetPlugin.ts) that the app's CloudFront serves to any site (lib/stacks/core-cdn.ts;
 * docs/feedback-forms.md, "The script embed").
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

/** Where the app serves the widget file (frontend/widgetAssetPlugin.ts `WIDGET_PATH`; that file is build-only). */
export const WIDGET_PATH = '/widget/feedback-widget.js'

/** The element the script embed renders into. */
const CONTAINER_ID = 'voc-feedback-form'

/** The smallest height the iframe resizer sets, so a short screen never collapses the frame to a strip. */
export const IFRAME_MIN_HEIGHT = 320

/** The widget file's address on this app's origin (where the person copying the snippet is signed in). */
export function widgetScriptUrl(appOrigin: string = window.location.origin): string {
  return `${stripTrailingSlashes(appOrigin)}${WIDGET_PATH}`
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

/**
 * `value` as a single-quoted JavaScript string that stays one string inside an HTML `<script>`: a quote, a
 * backslash, a line break or an angle bracket is written as its `\uXXXX` escape.
 */
const unicodeEscape = (char: string): string => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
const jsString = (value: string): string => `'${value.replace(/[\\'\n\r\u2028\u2029<>]/g, unicodeEscape)}'`

/** The iframe's id: the form's id in the characters an id and a selector take as they are. */
const frameIdOf = (formId: string): string => `voc-form-${formId.replace(/[^\w-]/g, '-')}`

/**
 * The iframe, then a resizer: the form's page posts `{ type: 'voc-form-height', height }` whenever its height
 * changes, and the script sets the frame's height to it (at least `IFRAME_MIN_HEIGHT`), taking only a message from
 * this frame's own window and the API's origin. Without the script (a site that strips it) the frame stays 480 px
 * tall and the form scrolls inside it, as before.
 */
export function iframeSnippet(input: SnippetInput): string | null {
  const link = formLink(input, false)
  if (link === null) return null
  const frameId = frameIdOf(input.formId)
  return [
    '<iframe',
    `  id="${escapeAttribute(frameId)}"`,
    `  src="${escapeAttribute(link)}"`,
    '  style="width: 100%; height: 480px; border: none;"',
    `  title="${escapeAttribute(input.formName)}"`,
    '></iframe>',
    '<script>',
    '  (function (frame) {',
    "    window.addEventListener('message', function (event) {",
    '      var data = event.data;',
    `      if (event.source !== frame.contentWindow || event.origin !== ${jsString(new URL(link).origin)}) return;`,
    "      if (data && data.type === 'voc-form-height' && data.height > 0) {",
    `        frame.style.height = Math.max(${String(IFRAME_MIN_HEIGHT)}, Math.ceil(data.height)) + 'px';`,
    '      }',
    '    });',
    `  })(document.getElementById(${jsString(frameId)}));`,
    '</script>',
  ].join('\n')
}

/**
 * The `VoCFeedbackForm.init` call, with the language, the hidden fields' placeholders and the test token. Each
 * placeholder is a string, `'{USER_ID}'`, as in the link: pasted as it is, the form still renders (a bare `USER_ID`
 * would stop the whole call with a ReferenceError), and the developer replaces it with the value.
 */
function initLines(input: SnippetInput): string[] {
  const hidden = input.hidden.map((field) => `${field.id}: ${jsString(placeholderOf(field.id))}`).join(', ')
  return [
    'VoCFeedbackForm.init({',
    `  container: '#${CONTAINER_ID}',`,
    `  apiEndpoint: ${jsString(stripTrailingSlashes(input.apiEndpoint))},`,
    `  formId: ${jsString(input.formId)},`,
    `  language: ${jsString(input.language)},`,
    ...(input.hidden.length === 0 ? [] : [`  hidden: { ${hidden} },`]),
    ...(input.testToken === null ? [] : [`  test: ${jsString(input.testToken)},`]),
    '});',
  ]
}

/**
 * The script embed, whole: the element the form renders into, the widget file from this app, and the `init` call.
 * Null when the endpoint cannot address the form (the call would name an API no other site can reach).
 */
export function scriptEmbedSnippet(input: SnippetInput, widgetUrl: string = widgetScriptUrl()): string | null {
  if (formLink(input, false) === null) return null
  return [
    `<div id="${CONTAINER_ID}"></div>`,
    `<script src="${escapeAttribute(widgetUrl)}"></script>`,
    '<script>',
    ...initLines(input).map((line) => `  ${line}`),
    '</script>',
  ].join('\n')
}

/**
 * The in-app SDK: the widget file, loaded once in the app's page, then the `init` call the app makes when the person
 * takes the action the form asks about (into an element of the app's, `#voc-feedback-form` here).
 */
export function sdkSnippet(input: SnippetInput, widgetUrl: string = widgetScriptUrl()): string | null {
  if (formLink(input, false) === null) return null
  return [`<script src="${escapeAttribute(widgetUrl)}"></script>`, '', ...initLines(input)].join('\n')
}
