/**
 * Guard: a count placeholder in a locale string carries the number format.
 *
 * `{{count}}` renders the raw digits ("16799"); `{{count, number}}` renders them
 * with the app language's grouping ("16,799", "16.799" in German) — see
 * countFormat.test.ts. Every placeholder name below is a count of things at
 * every call site that fills it, so a new string that spells one without
 * `, number` fails here instead of shipping ungrouped digits.
 *
 * The call sites pass these as numbers: a string would render as "NaN" through
 * the number format, and a pre-formatted one must be listed in LEFT_PLAIN.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { supportedLanguages } from './languages'

const LOCALES_DIR = path.join(__dirname, '../../public/locales')
const PLURAL_SUFFIX = /_(one|other|zero|two|few|many)$/
const BARE_PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g

/** Placeholder names that hold a count (or a count limit) wherever they appear. */
const COUNT_PARAMS = new Set([
  'count', 'total', 'n', 'max', 'min', 'limit', 'days', 'shown', 'filtered', 'loaded', 'listed', 'unversioned',
  'items', 'objects', 'runs', 'today', 'calls', 'nodes', 'edges', 'loops', 'added', 'removed', 'replaced', 'merged',
  'documents', 'used', 'selected', 'received', 'cap', 'done', 'filled', 'archived', 'active', 'alarms', 'pages',
  'reviews', 'length', 'rounds', 'steps', 'maxSteps', 'writes', 'maxWrites', 'waits', 'maxWaits', 'thinks', 'maxThinks',
])

const ORDINAL = 'a position, revision or version number, not a count — an identifier is not grouped'
const PRE_FORMATTED = 'the call site passes an already formatted string'

/** `namespace:key` (plural suffix dropped) → the count-named placeholders it deliberately keeps bare. */
const LEFT_PLAIN: Readonly<Record<string, { params: readonly string[]; why: string }>> = {
  'agents:run.olderRevision': { params: ['n'], why: ORDINAL },
  'agents:run.rounds': { params: ['n'], why: ORDINAL },
  'agents:editor.loopFrameLabel': { params: ['n'], why: ORDINAL },
  'agents:editor.loopOption': { params: ['n'], why: ORDINAL },
  'agents:editor.loopTitle': { params: ['n'], why: ORDINAL },
  'agents:editor.revision': { params: ['n'], why: ORDINAL },
  'assistantTools:preview.plan.reference': { params: ['n'], why: ORDINAL },
  'briefing:cards.reviewN': { params: ['n'], why: ORDINAL },
  'briefing:cards.openReview': { params: ['n'], why: ORDINAL },
  'decisions:picker.linked': { params: ['n'], why: ORDINAL },
  'decisions:releaseWatch.evidenceItem': { params: ['n'], why: ORDINAL },
  'projectDetail:documents.versions.label': { params: ['n'], why: ORDINAL },
  'projectDetail:documents.versions.restoredFrom': { params: ['n'], why: ORDINAL },
  'projectDetail:documents.versions.restoreMessage': { params: ['n'], why: ORDINAL },
  'settings:companyContext.objectiveLegend': { params: ['n'], why: ORDINAL },
  'settings:myContext.objectiveLegend': { params: ['n'], why: ORDINAL },
  'assistantTools:preview.plan.after': { params: ['steps'], why: 'a joined list of step numbers ("2, 3")' },
  'assistantTools:preview.scraper.pagesN': { params: ['n'], why: 'the stored setting shown verbatim, as the string the record holds' },
  'assistantTools:preview.scraper.reviewsN': { params: ['n'], why: 'the stored setting shown verbatim, as the string the record holds' },
  'radar:settings.lastScanCounts': { params: ['added', 'merged'], why: 'each slot is an already translated plural phrase' },
  'components:categoriesManager.reprocess.stoppedAtCeiling': { params: ['max'], why: PRE_FORMATTED },
  'components:dimensionFields.tagsTooMany': { params: ['max'], why: PRE_FORMATTED },
  'memory:imports.counter': { params: ['max'], why: PRE_FORMATTED },
  'settings:shared.charCount': { params: ['max'], why: PRE_FORMATTED },
  'scrapers:manualImport.exceedsMax': { params: ['max'], why: PRE_FORMATTED },
  'scrapers:manualImport.draftDropped': { params: ['max'], why: PRE_FORMATTED },
}

/** Every `[namespace:key, value]` string of one locale, plural suffix dropped from the key. */
function localeStrings(lang: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (node: unknown, ns: string, prefix: string) => {
    if (typeof node === 'string') { out.push([`${ns}:${prefix.replace(PLURAL_SUFFIX, '')}`, node]); return }
    if (typeof node !== 'object' || node === null) return
    for (const [k, v] of Object.entries(node)) walk(v, ns, prefix === '' ? k : `${prefix}.${k}`)
  }
  for (const file of fs.readdirSync(path.join(LOCALES_DIR, lang)).filter((f) => f.endsWith('.json'))) {
    walk(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, file), 'utf8')), file.replace(/\.json$/, ''), '')
  }
  return out
}

/** The count-named placeholders a string spells without a format. */
function bareCounts(value: string): string[] {
  return [...value.matchAll(BARE_PLACEHOLDER)].flatMap((m) => (m[1] !== undefined && COUNT_PARAMS.has(m[1]) ? [m[1]] : []))
}

describe('count placeholders', () => {
  it.each([...supportedLanguages])('carry the number format in every %s string', (lang) => {
    const offenders = localeStrings(lang).flatMap(([key, value]) => {
      const kept = LEFT_PLAIN[key]?.params ?? []
      return bareCounts(value).filter((p) => !kept.includes(p)).map((p) => `${key}: {{${p}}} → {{${p}, number}}`)
    })
    expect(offenders).toStrictEqual([])
  })

  it('leave plain only placeholders that still exist bare in English', () => {
    const bareByKey = new Map<string, Set<string>>()
    for (const [key, value] of localeStrings('en')) {
      const found = bareByKey.get(key) ?? new Set<string>()
      for (const p of bareCounts(value)) found.add(p)
      bareByKey.set(key, found)
    }
    const stale = Object.entries(LEFT_PLAIN).flatMap(([key, { params }]) =>
      params.filter((p) => !(bareByKey.get(key)?.has(p) ?? false)).map((p) => `${key}: ${p}`))
    expect(stale).toStrictEqual([])
  })

  it('catch a bare count and accept a formatted one', () => {
    expect(bareCounts('Showing {{count}} of {{ total }} for {{name}}')).toStrictEqual(['count', 'total'])
    expect(bareCounts('Showing {{count, number}} of {{total, number}}')).toStrictEqual([])
  })
})
