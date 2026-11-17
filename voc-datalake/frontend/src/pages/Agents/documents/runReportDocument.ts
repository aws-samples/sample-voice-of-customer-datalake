/**
 * @fileoverview A run's report as a document (§6.4 [52] step 4): the adapter the run monitor's Reports panel and the
 * run workspace's Reports tab hand DocumentSurface (the panel variant), and which version is on screen.
 *
 * Each report (a commit's, the pull request's, the goal's) is Markdown the server renders from the run's records and
 * its agents' findings (`engineering/reports/render.py`), one immutable version after another. It is read only and
 * offers no edit (the surface edits only through a save, and a report has none), so it carries no read-only reason
 * either: there is nothing a person could change. Agent text: the `model` policy (safe links, no images).
 *
 * The version on screen never changes by itself (a newer one being written says so, with "Show v<n>").
 *
 * @module pages/Agents/documents/runReportDocument
 */
import { engineeringRunsApi } from '../../../api/engineeringRunsApi'
import { unlessGone } from './readOnly'
import type { DocumentAdapter, StoredDocument } from '../../../components/Document/types'
import type { EngineeringReportEntry } from '../../../api/engineeringRunsApi'

export interface ReportDocument extends StoredDocument {
  readonly level: string
  readonly subject: string
  readonly version: number
}

export function reportDocumentOf(entry: EngineeringReportEntry, version: number, report: { markdown: string }): ReportDocument {
  return { title: entry.subject, content: report.markdown, level: entry.level, subject: entry.subject, version }
}

/** The surface's adapter for one report of a run (`load` reads the same version again: a version never changes). */
export function runReportAdapter(runId: string, entry: EngineeringReportEntry): DocumentAdapter<ReportDocument> {
  return {
    id: `report:${runId}:${entry.level}:${entry.subject}`,
    contentType: 'markdown',
    policy: 'model',
    permissions: { edit: true },
    versionOf: (stored) => ({ token: `${stored.level}/${stored.subject}/v${String(stored.version)}`, number: stored.version }),
    load: async (stored) => {
      const report = await unlessGone(() => engineeringRunsApi.report(runId, entry.level, entry.subject, stored.version))
      return report && reportDocumentOf(entry, stored.version, report)
    },
  }
}

/** The versions to pick from, newest first. */
export function reportVersions(entry: EngineeringReportEntry): number[] {
  return Array.from({ length: entry.latest_version }, (_, index) => entry.latest_version - index)
}

/** A newer version than the one on screen, which the index lists now (null: none). */
export function newerReport(entry: EngineeringReportEntry, shown: number): number | null {
  return entry.latest_version > shown ? entry.latest_version : null
}
