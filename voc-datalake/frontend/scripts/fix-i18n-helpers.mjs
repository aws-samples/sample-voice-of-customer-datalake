/**
 * Pure helpers of fix-i18n.mjs, in their own module so a test can exercise them: importing
 * fix-i18n.mjs runs its main loop (Bedrock translation calls). No I/O here.
 */

/** Every `[dotted key, leaf value]` of a locale tree; lists are leaves (one implementation: i18n-locales.mjs). */
export { flattenEntries } from './i18n-locales.mjs'

/** The value at the dotted `key`, or undefined. */
export function getNested(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj)
}

/** A non-empty list of strings (a list-valued locale entry, e.g. suggested responses). */
export function isStringList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
}

/** Whether `key` is one item `<list key>.<i>` of a queued string list. */
export function listItemOf(key, listKeys) {
  return listKeys.some(([listKey]) => key.startsWith(`${listKey}.`) && /^\d+$/.test(key.slice(listKey.length + 1)))
}

/** A self-referencing English value such as "sidebar.messagesCount" resolved to its text. */
export function resolveEnValue(enData, rawValue) {
  if (typeof rawValue === 'string' && rawValue.includes('.') && !rawValue.includes(' ')) {
    const resolved = getNested(enData, rawValue)
    if (resolved && typeof resolved === 'string') return resolved
  }
  return rawValue
}

/** The target locales: every `--lang <code>` given, else all of `known`. An unknown code throws. */
export function selectedLanguages(argv, known) {
  const picked = argv.flatMap((arg, i) => (arg === '--lang' && argv[i + 1] ? [argv[i + 1]] : []))
  const unknown = picked.filter((lang) => !known.includes(lang))
  if (unknown.length > 0) throw new Error(`unknown --lang ${unknown.join(', ')} (known: ${known.join(', ')})`)
  return picked.length > 0 ? picked : known
}

/**
 * `[key, englishOtherText]` for every plural category `lang` uses that English has no key for
 * and the target still lacks (missing or empty), one per English `<base>_other` key.
 */
export function missingPluralForms(enData, enEntries, targetData, lang) {
  const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
  const out = []
  for (const [key, enValue] of enEntries) {
    if (!key.endsWith('_other')) continue
    const base = key.slice(0, -'_other'.length)
    const source = resolveEnValue(enData, enValue)
    if (typeof source !== 'string' || source.trim() === '') continue
    for (const category of categories) {
      const formKey = `${base}_${category}`
      if (getNested(enData, formKey) !== undefined) continue
      const current = getNested(targetData, formKey)
      if (typeof current === 'string' && current.trim() !== '') continue
      out.push([formKey, source])
    }
  }
  return out
}

/**
 * The JSON object in a Bedrock Messages answer. Haiku 5.5 may put a `thinking` block before its
 * `text` block, so the first `text` block is read; markdown fences around the JSON are stripped.
 */
export function parseAnswer(resp) {
  const textBlock = Array.isArray(resp?.content) ? resp.content.find((block) => block?.type === 'text') : undefined
  if (typeof textBlock?.text !== 'string') throw new Error(`no text block in the answer (stop_reason ${resp?.stop_reason})`)
  const cleaned = textBlock.text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(cleaned)
}
