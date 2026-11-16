/**
 * @fileoverview The name a review page may have, checked in the form before it is saved: the server's rule
 * (lambda/shared/web_review_targets.py `NAME_RE`, `MAX_NAME_CHARS`), which refused any other name with a raw 400.
 * Trimmed, 1-100 characters: a first letter A-Z or digit, then letters (any script), digits, spaces, ".", "_" or "-".
 * Python's `\w` on text is Unicode: letters and numbers of any script, and "_".
 * @module pages/Scrapers/webPageName
 */

/**
 * `NAME_RE` (`^[A-Za-z0-9][\w .-]*\Z`) and `MAX_NAME_CHARS` (100) in one: a `u` pattern's `{0,99}` counts characters
 * (code points), as Python counts them.
 */
const NAME_PATTERN = /^[A-Za-z0-9][\p{L}\p{N}_ .-]{0,99}$/u

/** Whether the server would store `name` as a review page's name (blank is the required check's, not this one). */
export function isWebPageName(name: string): boolean {
  return NAME_PATTERN.test(name.trim())
}
