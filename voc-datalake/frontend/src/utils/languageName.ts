/**
 * @fileoverview A language code shown as a name ("en" → "English", "pt-BR" → "Brazilian
 * Portuguese"), in the reader's own UI language, via `Intl.DisplayNames`.
 * @module utils/languageName
 */

/** The name of `code` in `displayIn`; the code itself when the browser cannot name it. */
export function languageName(code: string, displayIn: string): string {
  const names = displayNamesIn(displayIn)
  if (names === undefined) return code
  try {
    return names.of(code) ?? code
  } catch {
    // RangeError: not a well-formed language tag.
    return code
  }
}

/** The language-name formatter for `locale`; undefined when the browser has none. */
function displayNamesIn(locale: string): Intl.DisplayNames | undefined {
  try {
    return new Intl.DisplayNames([locale || 'en'], { type: 'language', fallback: 'code' })
  } catch {
    return undefined
  }
}
