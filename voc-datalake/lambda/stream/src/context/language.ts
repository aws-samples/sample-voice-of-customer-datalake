/**
 * Shared language-instruction helper.
 *
 * Single source of truth for:
 *   - the set of languages the model may be asked to ANSWER in
 *   - the human-readable language names used in model system prompts
 *   - `isSupportedLanguage`, the ONE runtime membership test for the allowlist
 *   - the `getLanguageInstruction` function consumed by both voc-context.ts and
 *     persona-prompt.ts
 *
 * ## This is NOT the shipped-UI-catalogue list, and the distinction matters
 *
 * The frontend's own `i18n/languages.ts` decides which languages the *interface*
 * is translated into (currently eight). This list decides which languages the
 * *model* may be told to reply in — a different question, because the model
 * answers fluently in languages we have no UI translation for.
 *
 * Conflating the two is how `it, nl, ru, ar, hi, sv, pl, tr` were dropped: they
 * were removed for having no UI catalogue, which silently forced English on any
 * API client that asked for them, even though nothing about safety required it.
 * Safety comes from interpolating a name from LANGUAGE_NAMES below and never the
 * caller's own string — so extending this list costs nothing and is purely a
 * coverage decision. They are restored here.
 *
 * An unrecognised locale is still silently treated as English (the
 * no-instruction case) rather than rejected, so older clients degrade gracefully.
 * Region and script subtags (`pt-BR`, `zh-Hans`) are not accepted; a caller
 * wanting those needs the base code today.
 */

/** Language codes the model may be asked to answer in. */
export const SUPPORTED_LANGUAGES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja',
  'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'tr', 'zh',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// Keyed by the type, so adding a code above without naming it here is a compile
// error rather than a silently unnamed language.
const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  ar: 'Arabic',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  sv: 'Swedish',
  tr: 'Turkish',
  zh: 'Chinese',
};

/**
 * Derived from LANGUAGE_NAMES so membership and naming are the SAME data: a
 * locale cannot be accepted by the allowlist but left unnamed, and the exhaustive
 * Record above makes the reverse a compile error. Keyed by `string` rather than
 * SupportedLanguage on purpose — that is what lets the guard below test an
 * unknown value without an assertion, and what makes `get()` honestly return
 * `string | undefined`.
 */
const NAME_LOOKUP: ReadonlyMap<string, string> = new Map(Object.entries(LANGUAGE_NAMES));

/**
 * Runtime membership test for the locale allowlist.
 *
 * This is the only place membership is decided.  schema.ts uses it to sanitise
 * `response_language`, so the allowlist and the language names cannot drift
 * apart into the two divergent copies this module replaced.  A type guard
 * rather than an assertion, per the repo convention.
 */
export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && NAME_LOOKUP.has(value);
}

/**
 * Build the "respond in <language>" system-prompt instruction.
 *
 * Returns an empty string for English (or when no language is specified) because
 * the model responds in English by default — an explicit instruction adds noise.
 */
export function getLanguageInstruction(lang: SupportedLanguage | undefined): string {
  if (!lang || lang === 'en') return '';
  // Insurance, NOT a fix, and deliberately labelled as such: the sole runtime
  // entry point parses through chatRequestSchema, whose preprocess step maps
  // anything outside the allowlist to undefined, so this lookup cannot miss
  // today. It exists so a future caller that does NOT go through the schema
  // degrades to "no instruction" instead of interpolating an unvalidated code
  // verbatim into the system prompt.
  const name = NAME_LOOKUP.get(lang);
  if (name === undefined) return '';
  return `IMPORTANT: You MUST respond entirely in ${name} (${lang}). All text, headings, labels, and explanations must be in ${name}.`;
}
