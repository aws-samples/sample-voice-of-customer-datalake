/**
 * Shared language-instruction helper.
 *
 * Single source of truth for:
 *   - the supported locale set (aligned with the eight shipped UI catalogues)
 *   - the human-readable language names used in model system prompts
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
 * Build the "respond in <language>" system-prompt instruction.
 *
 * Returns an empty string for English (or when no language is specified) because
 * the model responds in English by default — an explicit instruction adds noise.
 * Returns an empty string for any code that is not in SUPPORTED_LANGUAGES; the
 * schema's `.catch(undefined)` transform means that unrecognised values arrive
 * here as `undefined`, so this branch is defensive-only.
 */
export function getLanguageInstruction(lang: SupportedLanguage | undefined): string {
  if (!lang || lang === 'en') return '';
  const name = LANGUAGE_NAMES[lang];
  return `IMPORTANT: You MUST respond entirely in ${name} (${lang}). All text, headings, labels, and explanations must be in ${name}.`;
}
