/**
 * @fileoverview Tests for the pure breadcrumb trail builder.
 *
 * Kept apart from Breadcrumbs.test.tsx because these need neither a DOM nor a
 * router: they state what the trail IS for a given path, which is where the
 * precedence rules live.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import { buildCrumbs, RECORD_CRUMBS, SEGMENT_CRUMBS } from './routeCrumbs'

// The real `t`, so a table entry pointing at a key the catalogue lacks fails
// here rather than rendering the key path in the header.
const t = i18n.t.bind(i18n)

const labels = (path: string, recordName?: string) =>
  buildCrumbs(path.split('/').filter(Boolean), t, recordName).map((crumb) => crumb.label)

const paths = (path: string) =>
  buildCrumbs(path.split('/').filter(Boolean), t, undefined).map((crumb) => crumb.path)

describe('buildCrumbs', () => {
  it('starts every trail at Home', () => {
    expect(labels('/categories')[0]).toBe('Home')
    expect(paths('/categories')[0]).toBe('/')
  })

  it('translates a static route segment', () => {
    expect(labels('/data-explorer')).toStrictEqual(['Home', 'Data Explorer'])
  })

  it('stands in for a record id, and yields to its name once known', () => {
    expect(labels('/projects/proj_20260101120000')).toStrictEqual(['Home', 'Projects', 'Project'])
    expect(labels('/projects/proj_20260101120000', 'Checkout Friction'))
      .toStrictEqual(['Home', 'Projects', 'Checkout Friction'])
  })

  /**
   * The precedence that matters: a labelled child of a record parent is a route,
   * not a record. Resolving RECORD_CRUMBS first would label `/projects/settings`
   * "Project" even with a correct entry for `settings` — and the route-coverage
   * test could not catch it, because adding that entry is exactly what it asks
   * for. No such route exists today; this pins the rule before one does.
   */
  it('prefers a segment\'s own label over its parent\'s record stand-in', () => {
    expect(labels('/projects/settings')).toStrictEqual(['Home', 'Projects', 'Settings'])
  })

  it('keeps resolving past a record id in a deeper path', () => {
    expect(labels('/projects/proj_1/settings')).toStrictEqual(['Home', 'Projects', 'Project', 'Settings'])
  })

  // /feedback only redirects to /categories since the list page was consolidated
  // (#198), so the crumb names — and links to — where it actually lands.
  it('routes the legacy feedback segment to Categories', () => {
    expect(labels('/feedback/fb_1')).toStrictEqual(['Home', 'Categories', 'Feedback item'])
    expect(paths('/feedback/fb_1')).toStrictEqual(['/', '/categories', '/feedback/fb_1'])
  })

  it('builds a cumulative path per segment', () => {
    expect(paths('/projects/proj_1')).toStrictEqual(['/', '/projects', '/projects/proj_1'])
  })

  // A wiring bug, not user data — and unreachable for a real URL, since the
  // router has no catch-all: an unmatched path renders RouteErrorBoundary in
  // place of the whole layout, breadcrumbs included.
  it('falls back to the raw segment when nothing labels it', () => {
    expect(labels('/unknown-route')).toStrictEqual(['Home', 'unknown-route'])
  })
})

/**
 * Every label key must resolve. i18next echoes a missing key as its own path, so
 * a typo in either table — or a key dropped from the catalogue — would render
 * `breadcrumbs.chat` in the page header. `npm run check` does not run the i18n
 * gate (issue #257), so this is the check that runs on every commit.
 */
describe('label keys', () => {
  const entries = [
    ...Object.entries(SEGMENT_CRUMBS),
    ...Object.entries(RECORD_CRUMBS),
  ].map(([segment, crumb]) => [segment, crumb?.labelKey ?? ''] as const)

  it('covers both tables', () => {
    // Anti-vacuous guard: an empty list would make the case below pass.
    expect(entries.length).toBe(13)
    expect(entries.every(([, labelKey]) => labelKey.startsWith('common:breadcrumbs.'))).toBe(true)
  })

  // A sentinel `defaultValue`, not a comparison against the key: i18next echoes a
  // missing key WITHOUT its namespace prefix, so `t('common:breadcrumbs.x')` on a
  // missing key returns `breadcrumbs.x` — never equal to the qualified key it was
  // given, which makes the obvious assertion unfailable. Verified by planting a
  // key the catalogue lacks.
  it.each(entries)('%s resolves to a translation', (_segment, labelKey) => {
    const missing = '\u0000missing'
    const resolved = t(labelKey, { defaultValue: missing })
    expect(resolved).not.toBe(missing)
    expect(resolved).not.toContain('breadcrumbs.')
    expect(resolved.trim()).not.toBe('')
  })
})
