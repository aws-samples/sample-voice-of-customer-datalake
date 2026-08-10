/**
 * Shared language-instruction helper.
 *
 * Single source of truth for:
 *   - the supported locale set (aligned with the eight shipped UI catalogues)
 *   - the human-readable language names used in model system prompts
 *   - `isSupportedLanguage`, the ONE runtime membership test for the allowlist
 *   - the `getLanguageInstruction` function consumed by both voc-context.ts and
 *     persona-prompt.ts
 *
 * The extra codes previously listed only in voc-context.ts (it, nl, ru, ar, hi,
 * sv, pl, tr) had no UI catalogue behind them.  They are intentionally omitted
 * from SUPPORTED_LANGUAGES so that `response_language` validation in schema.ts
 * can use this set as the single allowlist.  An unrecognised locale is silently
 * treated as English (the no-instruction case) rather than rejected — older or
 * third-party clients degrade gracefully.
 */

/** Locale codes that have a shipped UI catalogue and are accepted by the API. */
export const SUPPORTED_LANGUAGES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  ja: 'Japanese',
  ko: 'Korean',
  pt: 'Portuguese',
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
