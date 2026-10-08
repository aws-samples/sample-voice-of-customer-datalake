/**
 * Find a dialog by its accessible name, never by position. The floating
 * assistant panel is a dialog too (non-modal, its open state persisted), so
 * "the last dialog" matched the panel whenever it was open, and the s3 wizard
 * steps timed out against it (QA 2.14.00, s3-07/08/10/11). Every modal of the
 * app has a name (ModalShell enforces one), so a name always exists to use.
 */
import type { Locator, Page } from '@playwright/test'

/** A string matches the whole name exactly; a RegExp is for dialogs that rename themselves. */
export function dialogNamed(page: Page, name: string | RegExp): Locator {
  return page.getByRole('dialog', typeof name === 'string' ? { name, exact: true } : { name })
}

/** `getByRole('dialog')` with no options object: a lookup that ignores the name. */
const UNNAMED_DIALOG = /getByRole\(\s*(['"`])dialog\1\s*\)/g

/**
 * What may follow an unnamed lookup: counting EVERY dialog (`.count()`, or the
 * locator handed straight to `expect(...)`, as in `toHaveCount(0)`). Anything
 * else — `.last()`, `.first()`, `.nth()`, `.or()`, `.getByRole(...)`, a
 * variable — picks one dialog by position, and may pick the assistant panel.
 */
const ALLOWED_AFTER = /^\s*(\.count\(\)|\)\s*\.(not\.)?toHaveCount\()/
/** How far past a lookup `ALLOWED_AFTER` looks (longer than any allowed suffix). */
const LOOKAHEAD_CHARS = 40

/** Line and block comments blanked out (same length, so line numbers hold); `://` in a URL string is kept. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_line, before: string) => before)
}

/**
 * Each `line: text` in `source` that looks a dialog up without a name. The
 * guard in `unit/helpers.spec.ts` runs it over every spec and helper, so the
 * pattern 2.15.00 replaced (verify F3) cannot come back.
 */
export function unnamedDialogLookups(source: string): string[] {
  const code = withoutComments(source)
  const lines = code.split('\n')
  const found: string[] = []
  for (const match of code.matchAll(UNNAMED_DIALOG)) {
    const end = (match.index ?? 0) + match[0].length
    if (ALLOWED_AFTER.test(code.slice(end, end + LOOKAHEAD_CHARS))) continue
    const line = code.slice(0, match.index).split('\n').length
    found.push(`${line}: ${(lines[line - 1] ?? '').trim()}`)
  }
  return found
}
