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
import { MCP_SCOPES } from '../api/mcpTokenSchema'

const LOCALES_DIR = join(process.cwd(), 'public', 'locales')

/**
 * Every leaf of a parsed locale file, as dot-joined path + value.
 *
 * Returns values as well as paths so both tests below can share one walker: the
 * colon check needs only paths, the scope-coverage check also needs to know the
 * entry is non-empty. That is what lets this file hold **no type assertion** —
 * `isRecord` narrows `unknown` instead, matching the rule the rest of this PR
 * follows (see the copy-and-delete note in api/mcpTokenSchema.ts). ESLint does
 * not enforce it here — `eslint.config.js` ignores test files — so it is a
 * choice rather than a constraint, and a walker that returns both is smaller
 * than a walker plus a cast.
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
    ].join('\n')).toEqual([])
  })

  it('has a scopeDesc entry for every MCP scope, in every locale', () => {
    // Closes the gap that DERIVING the key opens. The component renders
    // `mcp.scopeDesc.${scope.replace(':', '_')}`, so the link between the scope
    // constants and the locale entries is implicit — adding a scope (Phase 3
    // adds a write scope) without adding the key to all 8 locales renders a raw
    // key path in the mint form.
    //
    // Less severe than the original defect, because a visible `mcp.scopeDesc.x`
    // is obviously broken where the literal "read" looked like real copy. But
    // Phase 3 WILL add scopes, so the cheap loop is worth having now, and it
    // covers every locale rather than the `en` a component test would exercise.
    const missing: string[] = []
    const blank: string[] = []
    for (const { locale, file, path } of localeFiles()) {
      if (file !== 'projectDetail.json') continue
      const json: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      // Looked up in the FLATTENED leaf list, so no cast is needed to reach
      // into mcp.scopeDesc — the walker has already resolved the shape.
      const byPath = new Map(leafEntries(json).map((e) => [e.path, e.value]))
      for (const scope of MCP_SCOPES) {
        const key = `mcp.scopeDesc.${scope.replace(':', '_')}`
        if (!byPath.has(key)) missing.push(`${locale}: ${key}`)
        else {
          const value = byPath.get(key)
          if (typeof value !== 'string' || value.trim() === '') {
            blank.push(`${locale}: ${key}`)
          }
        }
      }
    }
    expect(missing, [
      'A scope in MCP_SCOPES has no description key in some locale, so the mint',
      'form will render the raw key path for it. The key is the scope with its',
      'colon replaced by an underscore (`feedback:read` -> `feedback_read`).',
    ].join('\n')).toEqual([])
    expect(blank, 'a scopeDesc entry exists but is empty').toEqual([])

    // Positive control: the loop must actually have compared something, or an
    // empty MCP_SCOPES / a renamed file would make the assertions vacuous.
    expect(MCP_SCOPES.length).toBeGreaterThan(0)
    expect(localeFiles().filter((f) => f.file === 'projectDetail.json').length)
      .toBeGreaterThanOrEqual(8)
  })
})
