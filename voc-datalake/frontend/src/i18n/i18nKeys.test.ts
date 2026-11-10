/**
 * @fileoverview Structural invariants over the locale JSON itself.
 *
 * The motivating defect: `mcp.scopeDesc` was keyed by MCP scope names, which
 * contain a colon (`feedback:read`). A colon is i18next's default `nsSeparator`,
 * so `t('mcp.scopeDesc.feedback:read')` was parsed as namespace
 * `mcp.scopeDesc.feedback` + key `read`, resolved to nothing, and rendered the
 * literal word **"read"** under every scope checkbox in the mint form.
 *
 * It shipped past 2969 passing tests because the component tests asserted
 * checkbox *names* (which contain the scope and were correct) and nothing
 * asserted the description text — and the failed lookup produced a plausible
 * word rather than a visible key path, so it read as intentional. It was found
 * only by opening the deployed site in a browser.
 *
 * The fix could NOT be `nsSeparator: false`, globally or per call: this app
 * depends on that separator (`SCORABLE_TYPE_META` resolves
 * `prioritization:docType.prd`; see i18n/options.ts, whose own comment records
 * that disabling it breaks the Prioritization badge and the Feedback Forms
 * document picker). So the keys were renamed to underscore form instead — and
 * this test is what stops the class returning, at test time, for any namespace
 * rather than the one that happened to be caught.
 *
 * @module i18n/i18nKeys.test
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOCALES_DIR = join(process.cwd(), 'public', 'locales')

/**
 * Every leaf of a parsed locale file, as dot-joined path + value.
 *
 * Returns values as well as paths (the colon check reads only paths; a future
 * value check can share the walker). `isRecord` narrows `unknown` instead of a
 * type assertion. ESLint does not enforce that here — `eslint.config.js`
 * ignores test files — so it is a choice rather than a constraint.
 *
 * (The per-project mint form's `mcp.scopeDesc` coverage check went with the
 * Export / MCP tab; the global Connect page has no per-scope descriptions.)
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function leafEntries(value: unknown, prefix = ''): { path: string; value: unknown }[] {
  if (!isRecord(value)) return [{ path: prefix, value }]
  return Object.entries(value)
    .flatMap(([k, v]) => leafEntries(v, prefix ? `${prefix}.${k}` : k))
}

function localeFiles(): { locale: string; file: string; path: string }[] {
  return readdirSync(LOCALES_DIR)
    .filter((entry) => statSync(join(LOCALES_DIR, entry)).isDirectory())
    .flatMap((locale) =>
      readdirSync(join(LOCALES_DIR, locale))
        .filter((f) => f.endsWith('.json'))
        .map((file) => ({ locale, file, path: join(LOCALES_DIR, locale, file) })))
}

describe('locale key structure', () => {
  it('finds locale files to check', () => {
    // Positive control: a glob that silently matched nothing would make every
    // assertion below vacuously green.
    //
    // Bounds, not equality: pinning the locale count here would make ADDING a
    // 9th language fail a test about colon keys — an unrelated failure that
    // teaches the next person nothing. The count belongs to i18n-check, not here.
    const files = localeFiles()
    expect(files.length).toBeGreaterThan(20)
    expect(new Set(files.map((f) => f.locale)).size).toBeGreaterThanOrEqual(8)
  })

  it('has no key containing a colon, i18next\'s namespace separator', () => {
    const offenders: string[] = []
    for (const { locale, file, path } of localeFiles()) {
      const json: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      for (const { path: key } of leafEntries(json)) {
        if (key.includes(':')) offenders.push(`${locale}/${file}: ${key}`)
      }
    }
    expect(offenders, [
      'A colon in a locale KEY is silently mis-resolved: i18next splits the',
      'lookup on the first colon and treats the left side as a namespace, so the',
      'value is never found and the right-hand fragment renders instead — which',
      'looks like real copy rather than a broken key.',
      '',
      'Do NOT fix this with `nsSeparator: false`: this app resolves',
      'namespace-qualified keys such as `prioritization:docType.prd`, and',
      'disabling the separator breaks the Prioritization badge and the Feedback',
      'Forms document picker (see i18n/options.ts).',
      '',
      'Key the entry without a colon (e.g. `feedback_read`) and derive it at the',
      'call site from the identifier.',
    ].join('\n')).toStrictEqual([])
  })
})
