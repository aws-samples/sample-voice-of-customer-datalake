/**
 * @fileoverview Which rows the page has: stored rows resolved against the documents on screen.
 * @module pages/Prioritization/rowCollection
 */

import { projectLineageSources, rowLineageOf } from './rowLineage'
import type { ProjectLineageSources } from './rowLineage'
import type {
  ProjectDocument,
} from '../../api/types'
import type {
  Project,
  PrioritizationRow,
} from '../../api/projectTypes'
import { isScorable } from './prioritizationUtils'
import type { PrioritizationRowView } from './prioritizationUtils'

/**
 * The batch detail read re-aligned to `projectIds` by INDEX, the alignment every
 * reader in this module relies on. The batch answers only the projects the caller
 * can view, in its own order; a missing one becomes `undefined` in its slot.
 */
export function alignDetails<T extends { project: { project_id: string } }>(
  projectIds: readonly string[],
  details: readonly T[],
): (T | undefined)[] {
  const byId = new Map(details.map((detail) => [detail.project.project_id, detail]))
  return projectIds.map((id) => byId.get(id))
}

/**
 * Which projects have something to score, and so should have a row.
 *
 * The page asks the API to ensure a default row for each of these, which is
 * idempotent server-side (`createPrioritizationRow`) — so this is a list of asks,
 * not a decision about how many rows exist. A project with no scorable document is
 * deliberately absent: the create route refuses one, and the page keeps its existing
 * invitation to write a PRD or a PR/FAQ for it.
 *
 * Details are aligned with `projects` by INDEX, the same way `collectRows` and
 * `collectProjectDocumentIds` align them.
 */
export function projectsNeedingARow(
  allProjectDetails: readonly ({ documents?: ProjectDocument[] } | undefined)[] | undefined,
  projects: readonly Project[] | undefined,
): string[] {
  if (!allProjectDetails || !projects) return []
  return allProjectDetails.flatMap((detail, index) => {
    const project = projects.at(index)
    if (!project || !detail?.documents) return []
    return detail.documents.some(isScorable) ? [project.project_id] : []
  })
}

/**
 * Which of the rows a batch of default-row asks handed back are still worth keeping.
 *
 * `ensuredRows` exists to cover the window the prioritization read cannot: the query
 * failing, or not having landed, on a page whose entire content is rows. Sticky for
 * the mount, it could only ever ADD a row — and phase 2 makes that wrong, because a
 * deleted row would stay on screen until a remount, with a delete that reported
 * success and changed nothing visible.
 *
 * So an AUTHORITATIVE read reconciles it: a read that actually published a rows map
 * reports every row in the partition, including ones this page never asked for, and
 * a row absent from it does not exist. `read === undefined` is every state in which
 * nothing has said that — the query still running, a failed read with nothing cached,
 * a response whose `rows` could not be read, and a deployment that publishes no
 * `rows` field at all — and each keeps the fallback exactly as phase 1 had it.
 *
 * THAT LAST STATE IS WHY THE CALLER DECIDES, and not `normalizeRows`: an absent field
 * normalises to `{}` (see there), which is indistinguishable from a deployment that
 * genuinely holds no rows — and reconciling against it would empty the page on a
 * deployment predating the field, where the asks are the only source of rows there
 * is. `Prioritization.tsx` therefore passes `undefined` unless the response CARRIED
 * a `rows` field, and an EMPTY published map is authoritative like any other: it
 * says the partition holds nothing, which after a delete is the true answer.
 *
 * A JUST-ANSWERED CREATE is the one case this drops something real: a row the ask
 * confirmed moments after an authoritative read that predates it is filtered out
 * until the next read lands. That is covered rather than overlooked — the effect
 * invalidates the read whenever an ask reports `created` — and the alternative is
 * keeping a row the current read says is gone, which is the state deletion has to be
 * able to produce.
 */
export function retainedEnsuredRows(
  ensured: Record<string, PrioritizationRow>,
  read: Record<string, PrioritizationRow> | undefined,
): Record<string, PrioritizationRow> {
  if (read === undefined) return ensured
  return Object.fromEntries(
    Object.entries(ensured).filter(([rowId]) => rowId in read),
  )
}

/**
 * How many rows each project has.
 *
 * ONE COURTESY GATE READS THIS: `api_delete_prioritization_row` refuses a project's
 * DEFAULT row with 409 while it is that project's ONLY row, which is the state every
 * project starts in — so without this every row on a typical page would offer an
 * admin a delete that cannot work, behind a dialog stating an irreversible effect that
 * will not occur.
 *
 * COUNTED OVER THE ROWS THEMSELVES, before `collectRows` narrows them, and that
 * distinction is the whole reason this takes the bare record rather than the view list.
 * `collectRows` DROPS a row whose project is not on screen and a row not one of whose
 * document ids resolves — so counting its output reports a project holding two rows as
 * holding one whenever the sibling is a row composed from a document since deleted, or
 * one whose project detail has not landed. The gate would merely withhold a control in
 * that window, which is recoverable; the SENTENCE beside it asserts the count as a fact
 * about stored state, and a false one is what a reviewer acts on.
 *
 * THE PARAMETER IS THE STORED ROWS RECORD, and narrowly so on purpose: the one argument
 * this function was rewritten to reject is `collectRows`' output, and a structural
 * parameter (anything carrying a `project_id`) accepted exactly that — so an edit
 * reverting the call site to the narrowed view list type-checked silently and put the
 * false sentence back with only a test between it and a merge. `PrioritizationRowView[]`
 * does not satisfy `Record<string, PrioritizationRow>`, so the miscount is now a compile
 * error rather than a comment. Taking the record also spares the caller an
 * `Object.values` whose result would be the wrong shape to pass anywhere else.
 *
 * Still a COUNT OF WHAT THIS PAGE KNOWS, not a query of the partition, and that is fine
 * for a courtesy gate: the server's 409 stays authoritative either way, so a stale count
 * can only mean a control is offered that is then refused in words
 * (`rowAction.deleteConflict`) — never a delete that happens when it should not. Whether
 * the count is settled ENOUGH TO EXPLAIN is a separate question the caller answers; see
 * `rowCountSettled` on `RowCompositionActions`.
 */
export function rowsPerProject(
  rows: Readonly<Record<string, PrioritizationRow>>,
): ReadonlyMap<string, number> {
  const counted = new Map<string, number>()
  for (const row of Object.values(rows)) {
    counted.set(row.project_id, (counted.get(row.project_id) ?? 0) + 1)
  }
  return counted
}

/**
 * The same map with one row dropped, or the map itself when it never held it.
 *
 * Returned UNCHANGED when the key is absent, so a caller using this in a state updater
 * does not re-render for a removal that removed nothing — which is the whole of what
 * `ensuredRows` and `localEdits` need after a delete.
 */
export function withoutRow<T>(
  known: Record<string, T>,
  rowId: string,
): Record<string, T> {
  if (!(rowId in known)) return known
  return Object.fromEntries(Object.entries(known).filter(([id]) => id !== rowId))
}

/**
 * Which documents a reviewer may compose a row from, per project.
 *
 * THE SAME CANDIDATE SET THE ROUTES VALIDATE AGAINST, resolved from the project read
 * the page already performs: `_scorable_document_ids` in `projects_handler.py` builds
 * it from the project's own partition filtered to `SCORABLE_SK_PREFIXES`, and this is
 * that rule read through `isScorable` — whose type table is pinned against the
 * backend's prefixes by `test_prioritization_scorable_types_lockstep.py`. So a
 * document offered here is one the compose route accepts, and one it refuses is not
 * offered.
 *
 * A PROTOTYPE IS DELIBERATELY ABSENT, because `isScorable` excludes it: it is context
 * a reviewer looks at rather than a document a row is scored on, and putting one in
 * `document_ids` is refused by the route ("not a PRD or a PR/FAQ"). The row still
 * carries the project's prototype as its own field; a reviewer simply has no choice
 * about it.
 *
 * A project with no scorable document gets NO ENTRY rather than an empty list, so a
 * lookup answering `undefined` and one answering `[]` cannot come to mean different
 * things at a call site. Details are aligned with `projects` by INDEX, the same way
 * `collectRows` and `projectsNeedingARow` align them.
 */
export function scorableDocumentsByProject(
  allProjectDetails: readonly ({ documents?: ProjectDocument[] } | undefined)[] | undefined,
  projects: readonly Project[] | undefined,
): Map<string, ProjectDocument[]> {
  const byProject = new Map<string, ProjectDocument[]>()
  if (!allProjectDetails || !projects) return byProject
  for (const [index, detail] of allProjectDetails.entries()) {
    const project = projects.at(index)
    if (!project || !detail) continue
    const scorable = (detail.documents ?? []).filter(isScorable)
    if (scorable.length > 0) byProject.set(project.project_id, scorable)
  }
  return byProject
}

/**
 * The rows the page renders: the server's rows, resolved against the documents on
 * screen.
 *
 * ONE ROW PER PROJECT, because that is what a row now is. Which documents a row
 * holds is the SERVER'S answer (`rows[].document_ids`, concrete ids frozen when the
 * row was composed) rather than "every scorable document of this project" recomputed
 * here — otherwise generating a new PRD would silently change what an existing row's
 * ballots describe, which is the whole point of the row storing ids.
 *
 * A row is DROPPED when:
 *   * its project is not in the list on screen — nothing can name or open it; or
 *   * not one of its document ids resolves to a document that project still has.
 *     Such a row has nothing to show and nothing to score, and its title would have
 *     to be invented. It is not deleted server-side by this: the ballots stay, and
 *     the row reappears the moment its documents do.
 *
 * Documents are ordered NEWEST FIRST, and the leading one names the row — a row has
 * no title of its own, and a reviewer scanning the list is looking for the proposal's
 * name. Every document stays in the list, because each remains individually visible
 * inside the expanded row with its own collected form evidence.
 *
 * The prototype is resolved from the row's own `prototype_id` when the row names one,
 * and otherwise falls back to the project's newest prototype — which is what a row
 * created before this field existed, or one whose named prototype has since been
 * deleted, would otherwise show nothing for. A prototype is context rather than
 * something the row is scored on, so a stale pointer there costs a reader a demo, not
 * the meaning of their ballot.
 */
export function collectRows(
  rows: Record<string, PrioritizationRow>,
  allProjectDetails: readonly ({ documents?: ProjectDocument[] } | undefined)[] | undefined,
  projects: readonly Project[] | undefined,
): PrioritizationRowView[] {
  if (!allProjectDetails || !projects) return []
  /**
   * Each project read, prepared ONCE for however many rows name it.
   *
   * `byId` resolves a row's stored ids and its prototype; `lineage` is the same
   * documents plus the derivation source index the lineage rules resolve every
   * recorded source against. Both were built inside the per-row loop, over a list
   * that cannot change while it runs, so one project read of D documents was walked
   * once per row — and the index, which the classifiers ask for per row AND per
   * document on that row, once per (row × document × rule). ONE SOURCE INDEX PER
   * PROJECT READ, NOT PER CALL; see `ProjectLineageSources` (issue #399 B) for the
   * measurement, and `prioritizationUtils.indexReuse.test.ts` for the count that
   * pins it. Prepared here rather than memoised inside the shared helper so the
   * index's lifetime is this pass's and there is nothing to invalidate — the next
   * call gets a new one from whatever the reads then say.
   *
   * PER PROJECT READ AND NOT PER ROW, which is one `Map` and one index MORE than
   * before for a loaded project no visible row names — `byId` used to be built
   * lazily inside the loop. Deliberate: `Prioritization.tsx` fans out over exactly
   * the projects it shows, so the untouched-project case is hypothetical, while the
   * per-row rebuild was the measured cost.
   */
  const byProject = new Map<string, {
    name: string;
    documents: ProjectDocument[]
    byId: Map<string, ProjectDocument>
    lineage: ProjectLineageSources
  }>()
  for (const [index, detail] of allProjectDetails.entries()) {
    const project = projects.at(index)
    if (!project || !detail) continue
    const documents = detail.documents ?? []
    byProject.set(project.project_id, {
      name: project.name,
      documents,
      byId: new Map(documents.map((doc) => [doc.document_id, doc])),
      lineage: projectLineageSources(documents),
    })
  }

  return Object.values(rows).flatMap((row): PrioritizationRowView[] => {
    const project = byProject.get(row.project_id)
    if (!project) return []
    const byId = project.byId
    const documents = row.document_ids
      .flatMap((documentId) => {
        const doc = byId.get(documentId)
        return doc ? [doc] : []
      })
      .sort(byNewestFirst)
    const leading = documents.at(0)
    if (!leading) return []
    return [{
      row_id: row.row_id,
      project_id: row.project_id,
      project_name: project.name,
      documents,
      title: leading.title,
      created_at: leading.created_at,
      // The row's own stored answer, not a guess from the ballots on screen: the
      // page holds only the CALLER'S ballots, so deriving this here would read a row
      // somebody else has voted on as editable.
      is_frozen: row.is_frozen,
      // Carried for the one courtesy gate that reads it — see the field's own comment
      // on `PrioritizationRowView` and `rowsPerProject`.
      is_default: row.is_default,
      /**
       * What these documents say about each other, resolved HERE because this is
       * where the row's own documents and the project's whole list are both in
       * hand — and once per row rather than per render.
       *
       * The row's RESOLVED documents are the selection, so the lineage describes
       * the same concrete ids the ballots were cast on. The project's documents
       * are what each recorded source is looked up against, and staleness is
       * measured against; a project whose detail has not landed contributes an
       * empty list, and every rule then withholds its judgement rather than
       * inventing one.
       *
       * UNLESS AN ID DID NOT RESOLVE, which is the one case where "the same concrete
       * ids the ballots were cast on" stops being true of `documents`: the resolution
       * above drops a stored id the project no longer holds, and a row survives that
       * as long as ANY id resolved. `composition_truncated` carries the difference so
       * the advisory can withhold — it would otherwise name a combination missing a
       * type the ballots covered — while the classification still describes the
       * documents actually on screen. Argued at `rowLineageOf`.
       */
      lineage: rowLineageOf({
        is_frozen: row.is_frozen,
        documents,
        composition_truncated: documents.length !== row.document_ids.length,
      }, project.lineage),
      prototype: byId.get(row.prototype_id) ?? latestPrototypeOf(project.documents),
    }]
  })
}

/**
 * The project's newest prototype, for a row that names none this project still has.
 *
 * The fallback rather than the rule: a row stores the prototype it was composed
 * with, and this is what keeps a demo on screen for a row composed before the field
 * existed, or one whose prototype has since been deleted.
 */
function latestPrototypeOf(documents: readonly ProjectDocument[]): ProjectDocument | undefined {
  return documents
    .filter((doc) => doc.document_type === 'prototype')
    .slice()
    .sort(byNewestFirst)[0]
}

/**
 * Newest first, and EQUAL timestamps compare EQUAL.
 *
 * The equal arm is the whole of this, and it was missing at both call sites. Without it
 * the comparator answers -1 for a tied pair in either order, which is not an ordering
 * at all: two documents sharing a `created_at` come out in whichever order their
 * positions in the array happen to produce, and three of them come out reversed.
 *
 * Not academic here. A PRD and a PR/FAQ generated from ONE request share a timestamp,
 * which is the ordinary shape of a row holding both — and the LEADING document gives
 * the row its `title` and its `created_at`, so the name the list shows and the value
 * the date sort reads were both being decided by array position. Two reviewers looking
 * at the same data could be shown the same row under different names.
 *
 * Returning 0 leaves a tied pair in the order the row itself lists them
 * (`Array.prototype.sort` is stable), i.e. the stored `document_ids` order — a rule,
 * and one the server controls.
 */
function byNewestFirst(a: ProjectDocument, b: ProjectDocument): number {
  if (a.created_at === b.created_at) return 0
  return a.created_at < b.created_at ? 1 : -1
}
