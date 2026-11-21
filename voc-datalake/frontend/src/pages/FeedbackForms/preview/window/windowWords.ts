/**
 * @fileoverview The preview window's own words (its toolbar and its notes; the form speaks through the widget). The
 * window has no i18next: it reads the app's own catalog, `/locales/<app language>/feedbackForms.json` (the address
 * the app's loader uses, so a deploy never serves an old one), and takes the `previewWindow` part. A language whose
 * catalog cannot be read falls back to the English catalog, and only when neither can be read (the app is offline)
 * to the English kept here.
 *
 * @module pages/FeedbackForms/preview/window/windowWords
 */
import { LOCALE_LOAD_PATH } from '../../../../i18n/loadPath'
import { isRecord } from '../../../../lib/typeGuards'

/** Each word: the catalog key it is kept under (the i18n check reads these), and its last-resort English. */
const WORDS = {
  title: { textKey: 'feedbackForms:previewWindow.title', english: 'Form preview' },
  region: { textKey: 'feedbackForms:previewWindow.region', english: 'Form preview, {{language}}' },
  size: { textKey: 'feedbackForms:previewWindow.size', english: 'Window size' },
  language: { textKey: 'feedbackForms:previewWindow.language', english: 'Preview language' },
  restart: { textKey: 'feedbackForms:previewWindow.restart', english: 'Restart' },
  waiting: { textKey: 'feedbackForms:previewWindow.waiting', english: 'Waiting for the form. Keep it open in the builder.' },
  noSession: { textKey: 'feedbackForms:previewWindow.noSession', english: 'Open this preview from the form builder.' },
  unavailable: {
    textKey: 'feedbackForms:previewWindow.unavailable',
    english: "The preview can't start: the form widget didn't load. Reload this window to try again.",
  },
  resizeRefused: { textKey: 'feedbackForms:previewWindow.resizeRefused', english: "Your browser kept this window's size." },
  sizeOption: { textKey: 'feedbackForms:previewWindow.sizeOption', english: '{{name}} · {{width}} × {{height}}' },
  custom: { textKey: 'feedbackForms:previewWindow.custom', english: 'Custom · {{width}} × {{height}}' },
  phone: { textKey: 'feedbackForms:previewWindow.presets.phone', english: 'Phone' },
  rotate: { textKey: 'feedbackForms:previewWindow.presets.rotate', english: 'Phone, rotated' },
  tablet: { textKey: 'feedbackForms:previewWindow.presets.tablet', english: 'Tablet' },
  desktop: { textKey: 'feedbackForms:previewWindow.presets.desktop', english: 'Desktop' },
  embedded: { textKey: 'feedbackForms:previewWindow.presets.embedded', english: 'Embedded, 480 px tall' },
} as const

type WordId = keyof typeof WORDS

/** A word, with its `{{placeholders}}` filled. */
export type Words = (id: WordId, values?: Readonly<Record<string, string | number>>) => string

/** The languages the app ships catalogs for (src/i18n/languages.ts); anything else reads English. */
const UI_LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl'])


/** The text at `path` (dot-separated, after the namespace) in a parsed catalog, or null. */
function lookUp(catalog: unknown, path: string): string | null {
  const found = path.split('.').reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), catalog)
  return typeof found === 'string' && found.trim() !== '' ? found : null
}

async function readCatalog(language: string): Promise<unknown> {
  const url = LOCALE_LOAD_PATH.replace('{{lng}}', language).replace('{{ns}}', 'feedbackForms')
  try {
    const response = await fetch(url, { credentials: 'same-origin' })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

export function fill(text: string, values: Readonly<Record<string, string | number>> = {}): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/gu, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole))
}

/** The language the window speaks for an app language from its address ("pl", or English for anything unknown). */
export function windowLanguage(requested: string): string {
  const short = requested.slice(0, 2).toLowerCase()
  return UI_LANGUAGES.has(short) ? short : 'en'
}

/** The window's words in `language`, falling back word by word to English. */
export async function loadWords(language: string): Promise<Words> {
  const [own, english] = await Promise.all([readCatalog(language), language === 'en' ? Promise.resolve(null) : readCatalog('en')])
  const fallback = language === 'en' ? own : english
  return (id, values) => {
    const { textKey, english: lastResort } = WORDS[id]
    const path = textKey.slice(textKey.indexOf(':') + 1)
    return fill(lookUp(own, path) ?? lookUp(fallback, path) ?? lastResort, values)
  }
}
