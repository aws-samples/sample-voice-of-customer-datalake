/**
 * @fileoverview Route → breadcrumb label resolution.
 *
 * Split out of Breadcrumbs.tsx so the tables and the pure builder can be
 * imported by tests (and read) without pulling in the component — which is also
 * what react-refresh wants from a file that exports non-components.
 *
 * Labels are keys into the `common:breadcrumbs` catalogue, which ships in all 8
 * locales. Nothing here holds English: the component used to carry a
 * `routeLabels` map that duplicated that catalogue key for key, so breadcrumbs
 * rendered English in every locale while the translations were downloaded and
 * never read.
 *
 * @module components/Breadcrumbs/routeCrumbs
 */
import type { TFunction } from 'i18next'

export interface CrumbLabel {
  /**
   * Fully qualified (`ns:key`), and held in a property named `labelKey`, so
   * scripts/i18n-check.mjs can see it through the tables below — its
   * extractDataHeldKeys matches exactly that shape, the same way it sees
   * Layout's NAV_ITEMS. A computed `t(`breadcrumbs.${segment}`)`, or a bare
   * `segment: 'common:breadcrumbs.x'` pair, is invisible to that gate: keys
   * reachable only that way get reported as unreferenced, which is how these
   * translations sat unread for so long without anything failing.
   */
  labelKey: string
}

export interface RouteCrumb extends CrumbLabel {
  /** Where the crumb links, when that is not the segment's own path. */
  path?: string
}

/**
 * Static route segment → its shipped label.
 *
 * `feedback` deliberately resolves to the Categories crumb: the standalone
 * feedback list was consolidated into Categories (#198) and `/feedback` now only
 * redirects there, so a feedback item's parent crumb names — and links to — the
 * page the user actually lands on. That is also why the catalogue has no
 * `breadcrumbs.feedback` key to point at.
 */
export const SEGMENT_CRUMBS: Readonly<Partial<Record<string, RouteCrumb>>> = {
  'dashboard': { labelKey: 'common:breadcrumbs.dashboard' },
  'categories': { labelKey: 'common:breadcrumbs.categories' },
  'feedback': { labelKey: 'common:breadcrumbs.categories', path: '/categories' },
  'problems': { labelKey: 'common:breadcrumbs.problems' },
  'chat': { labelKey: 'common:breadcrumbs.chat' },
  'projects': { labelKey: 'common:breadcrumbs.projects' },
  'prioritization': { labelKey: 'common:breadcrumbs.prioritization' },
  'data-explorer': { labelKey: 'common:breadcrumbs.dataExplorer' },
  'scrapers': { labelKey: 'common:breadcrumbs.scrapers' },
  'feedback-forms': { labelKey: 'common:breadcrumbs.feedbackForms' },
  'settings': { labelKey: 'common:breadcrumbs.settings' },
}

/**
 * Segments whose CHILD segment is a record id rather than a route, mapped to the
 * label that stands in for that record.
 *
 * An id is not a label — `/projects/proj_20260101120000` used to render that
 * string at the end of the trail — so the child crumb shows the record's own name
 * once the page has loaded it, and this generic label until then.
 *
 * `route coverage` in Breadcrumbs.test.tsx holds both tables to the real router:
 * every layout route needs a label and every `:param` route needs a stand-in, so
 * a new `/thing/:id` page cannot quietly put an id back in the header.
 */
export const RECORD_CRUMBS: Readonly<Partial<Record<string, CrumbLabel>>> = {
  'projects': { labelKey: 'common:breadcrumbs.project' },
  'feedback': { labelKey: 'common:breadcrumbs.feedbackItem' },
}

export interface Crumb {
  label: string
  path: string
  isHome: boolean
}

/**
 * The trail for one pathname, Home first.
 *
 * @param pathSegments non-empty path segments of the current location
 * @param recordName display name of the record this route addresses, when the
 *   page has already loaded it (see useRecordName)
 */
export function buildCrumbs(
  pathSegments: readonly string[],
  t: TFunction,
  recordName: string | undefined,
): Crumb[] {
  return [
    // Qualified like the tables, so the label does not depend on which
    // namespace the caller's `t` happens to be bound to.
    { label: t('common:breadcrumbs.home'), path: '/', isHome: true },
    ...pathSegments.map((segment, index) => {
      const segmentPath = '/' + pathSegments.slice(0, index + 1).join('/')
      const record = index === 0 ? undefined : RECORD_CRUMBS[pathSegments[index - 1]]
      if (record !== undefined) {
        return { label: recordName ?? t(record.labelKey), path: segmentPath, isHome: false }
      }
      // No entry means a route with no breadcrumb label, which is a wiring bug
      // rather than user data — the raw segment is the most useful thing to show.
      const route = SEGMENT_CRUMBS[segment]
      return {
        label: route === undefined ? segment : t(route.labelKey),
        path: route?.path ?? segmentPath,
        isHome: false,
      }
    }),
  ]
}
