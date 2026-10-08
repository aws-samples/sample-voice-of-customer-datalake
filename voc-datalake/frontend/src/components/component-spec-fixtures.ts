/**
 * @fileoverview Spec helpers shared by the component suites.
 *
 * Text checks: "every one of these strings is (or is not) rendered", asserted
 * in one structured expectation —
 * `expect(textsMissingFromScreen([...])).toStrictEqual([])` — so a failure
 * names exactly the strings that broke. Each lookup is `screen.queryByText`,
 * which throws on more than one match, so these keep the "exactly one"
 * strictness of the `getByText` calls they replace.
 */
import { screen, type SelectorMatcherOptions } from '@testing-library/react'

/** The strings of `texts` that are NOT on screen. */
export function textsMissingFromScreen(
  texts: readonly string[],
  options?: SelectorMatcherOptions,
): string[] {
  return texts.filter((text) => screen.queryByText(text, options) === null)
}

/** The strings of `texts` that ARE on screen. */
export function textsPresentOnScreen(
  texts: readonly string[],
  options?: SelectorMatcherOptions,
): string[] {
  return texts.filter((text) => screen.queryByText(text, options) !== null)
}

/**
 * `value` narrowed to non-null, throwing (and so failing the spec) when a lookup
 * found nothing — instead of an `as` assertion or an `if` inside the test body.
 */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}`)
  return value
}
