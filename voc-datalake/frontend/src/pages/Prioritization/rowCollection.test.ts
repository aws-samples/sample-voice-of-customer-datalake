/**
 * @fileoverview Tests for rowCollection — which rows the page has.
 */
import { describe, it, expect } from 'vitest'
import { collectRows, retainedEnsuredRows, rowsPerProject, scorableDocumentsByProject, withoutRow } from './rowCollection'
import type { PrioritizationRow } from '../../api/projectTypes'
import { byLocale, doc, onlyItem, project, storedRow } from './prioritization-unit-fixtures'

/** Resolve ONE stored row of project `p1` — on screen as `P1` — against `details`. */
const collectOneRow = (
  documentIds: string[],
  details: Parameters<typeof collectRows>[1],
  prototypeId = '',
) => collectRows(
  { 'row-1': storedRow('row-1', 'p1', documentIds, prototypeId) },
  details, [project('p1', 'P1')],
)

/**
 * Resolve the one row once per stored id order in `orders`, and check each against
 * what `expected` says that order must show: the documents in order, and the title.
 * Each assertion is labelled with the order it ran, so a failure names it.
 */
const expectRowForEachIdOrder = (
  details: Parameters<typeof collectRows>[1],
  orders: string[][],
  expected: (documentIds: string[]) => { documentIds: string[]; title: string },
) => {
  for (const documentIds of orders) {
    const label = documentIds.join(',')
    const row = onlyItem(collectOneRow(documentIds, details), label)
    const want = expected(documentIds)
    expect(row.documents.map((d) => d.document_id), label).toStrictEqual(want.documentIds)
    expect(row.title, label).toBe(want.title)
  }
}

/** The one document on screen for the cases about ids that do not resolve. */
const ONE_PRD_ON_SCREEN = [{ documents: [doc('prd-1', 'prd', 'A', '2025-01-01')] }]

describe('collectRows resolves stored rows against the documents on screen', () => {
  it('returns nothing when the project reads are missing or empty', () => {
    // The PROJECT half, in both of its absences — never read, and read as empty. Not
    // `[]` as a stand-in for "still loading": the page distinguishes those, and this
    // function is only reached once both reads exist. An empty ROWS map is covered by
    // `normalizeRows`' own cases and by the drop rules below, which is why both
    // branches here pass `{}` for it.
    expect(collectRows({}, undefined, undefined)).toStrictEqual([])
    expect(collectRows({}, [], [])).toStrictEqual([])
  })

  it('returns nothing when the rows map is empty though the projects are read', () => {
    // The other half, stated rather than implied: rows are what put a row on screen,
    // so a deployment holding none renders nothing even with projects full of
    // scorable documents. This is the state the page's empty invitation covers.
    //
    // Paired with its own positive control, because "empty in, empty out" is what a
    // function ignoring its project arguments entirely would also answer: the SAME
    // details and projects, with one row named, produce that row. So the `[]` above is
    // the rows map deciding it, not the documents being unreachable.
    const details = [{ documents: [doc('prd-1', 'prd', 'Feature A PRD', '2025-01-01')] }]
    const projects = [project('p1', 'P1')]

    expect(collectRows({}, details, projects)).toStrictEqual([])
    expect(collectRows(
      { 'row-1': storedRow('row-1', 'p1', ['prd-1']) },
      details,
      projects,
    ).map((row) => row.row_id)).toStrictEqual(['row-1'])
  })

  it('names a row by its stored id order when its documents share a created_at', () => {
    // A PRD and a PR/FAQ generated from ONE request carry the same timestamp, which is
    // the ordinary shape of a row holding both. The LEADING document gives the row its
    // title and its created_at — the name the list shows and the value the date sort
    // reads — and the newest-first comparator had no equal arm, so it answered -1 for a
    // tied pair in EITHER order. Not an ordering: the winner was decided by position in
    // the array, so two reviewers on the same data could see the row under two names.
    //
    // Driven from both id orders, which must each be honoured. The project read lists
    // the documents in the opposite order to the first case on purpose, so this cannot
    // pass on the fixture's ordering.
    // The same instant, as a full ISO timestamp, so the equality these cases turn on is
    // explicit rather than incidental to how two shorter strings happen to compare.
    const sameInstant = '2025-01-01T09:00:00Z'
    const details = [{
      project_id: 'p1',
      documents: [
        doc('prfaq-1', 'prfaq', 'Feature A PR/FAQ', sameInstant),
        doc('prd-1', 'prd', 'Feature A PRD', sameInstant),
      ],
    }]

    expectRowForEachIdOrder(
      details,
      [['prd-1', 'prfaq-1'], ['prfaq-1', 'prd-1']],
      (documentIds) => ({
        documentIds,
        title: documentIds[0] === 'prd-1' ? 'Feature A PRD' : 'Feature A PR/FAQ',
      }),
    )
  })

  it('still leads with a genuinely newer document, whichever order the ids arrive in', () => {
    // The positive control for the tie above: adding the equal arm must not flatten the
    // ordering into "whatever the row listed".
    const details = [{
      project_id: 'p1',
      documents: [
        doc('prfaq-1', 'prfaq', 'Older', '2025-01-01T09:00:00Z'),
        doc('prd-1', 'prd', 'Newer', '2025-02-01T09:00:00Z'),
      ],
    }]

    expectRowForEachIdOrder(
      details,
      [['prfaq-1', 'prd-1'], ['prd-1', 'prfaq-1']],
      () => ({ documentIds: ['prd-1', 'prfaq-1'], title: 'Newer' }),
    )
  })

  it('picks a stable prototype when a project has two of the same age', () => {
    // The same comparator at its other call site — the fallback that keeps a demo on
    // screen for a row naming no prototype. A tie decided by array position means two
    // reviewers on identical data can be shown different prototypes.
    const sameInstant = '2025-03-01T12:00:00Z'
    const details = [{
      project_id: 'p1',
      documents: [
        doc('prfaq-1', 'prfaq', 'Feature A PR/FAQ', '2025-01-01T09:00:00Z'),
        doc('proto-a', 'prototype', 'Proto A', sameInstant),
        doc('proto-b', 'prototype', 'Proto B', sameInstant),
      ],
    }]

    const rows = collectOneRow(['prfaq-1'], details)

    // The first of the tied pair as the project lists them, kept by the stable sort
    // rather than swapped by a comparator that never answers equal.
    expect(onlyItem(rows, 'the row').prototype?.document_id).toBe('proto-a')
  })

  it('a project whose PRD and PR/FAQ describe one idea is ONE row', () => {
    // The whole point of the change. Two scorable documents, one row, one ballot —
    // where the page previously listed the same idea twice and scored it twice.
    const details = [{
      documents: [
        doc('prfaq-1', 'prfaq', 'Feature A PR/FAQ', '2025-01-02'),
        doc('prd-1', 'prd', 'Feature A PRD', '2025-01-01'),
        doc('research-1', 'research', 'Research', '2025-01-03'),
      ],
    }]

    const rows = collectOneRow(['prd-1', 'prfaq-1'], details)

    const row = onlyItem(rows, 'the one idea')
    expect(row.row_id).toBe('row-1')
    expect(row.project_name).toBe('P1')
    expect(row.documents.map((d) => d.document_id)).toStrictEqual(['prfaq-1', 'prd-1'])
  })

  it('holds only the documents the row NAMES, not every scorable one the project has', () => {
    // A row stores concrete ids. Recomputing "every scorable document of this
    // project" would make generating a new PRD silently change what an existing
    // row's ballots describe — which is the property the ids exist to give.
    const details = [{
      documents: [
        doc('prd-1', 'prd', 'Original PRD', '2025-01-01'),
        doc('prd-2', 'prd', 'Regenerated PRD', '2025-06-01'),
      ],
    }]

    const rows = collectOneRow(['prd-1'], details)

    expect(onlyItem(rows, 'the row').documents.map((d) => d.document_id)).toStrictEqual(['prd-1'])
  })

  it('names the row after its NEWEST document, which is also what the date sort reads', () => {
    const details = [{
      documents: [
        doc('prd-1', 'prd', 'Older PRD', '2025-01-01'),
        doc('prfaq-1', 'prfaq', 'Newer PR/FAQ', '2025-03-01'),
      ],
    }]

    const row = onlyItem(collectOneRow(['prd-1', 'prfaq-1'], details), 'the row')

    expect(row.title).toBe('Newer PR/FAQ')
    expect(row.created_at).toBe('2025-03-01')
  })

  it('drops a row whose project is not on screen rather than rendering it unattributed', () => {
    const rows = collectRows(
      { 'row-1': storedRow('row-1', 'p-gone', ['prd-1']) },
      ONE_PRD_ON_SCREEN,
      [project('p1', 'P1')],
    )

    expect(rows).toStrictEqual([])
  })

  it('drops a row when NONE of its ids resolve, because there is nothing to score', () => {
    // A stored row naming only deleted documents has no title, no preview and
    // nothing a reviewer could read. The backend ignores a ballot keyed to a row
    // that no longer resolves for the same reason.
    const rows = collectOneRow(['deleted-1', 'deleted-2'], ONE_PRD_ON_SCREEN)

    expect(rows).toStrictEqual([])
  })

  it('keeps a row whose ids PARTLY resolve, holding the ones that do', () => {
    const rows = collectOneRow(['prd-1', 'deleted-1'], ONE_PRD_ON_SCREEN)

    expect(onlyItem(rows, 'the partly resolved row').documents.map((d) => d.document_id))
      .toStrictEqual(['prd-1'])
  })

  /** A PR/FAQ beside two prototypes, the newer of which the fallback picks. */
  const prfaqWithTwoPrototypes = [{
    documents: [
      doc('prfaq-1', 'prfaq', 'A', '2025-01-01'),
      doc('proto-old', 'prototype', 'Old Proto', '2025-01-10'),
      doc('proto-new', 'prototype', 'New Proto', '2025-02-01'),
    ],
  }]

  it('carries the prototype the row was composed with', () => {
    const rows = collectOneRow(['prfaq-1'], prfaqWithTwoPrototypes, 'proto-old')

    expect(onlyItem(rows, 'the row').prototype?.document_id).toBe('proto-old')
  })

  it('falls back to the project latest prototype when the row names none', () => {
    // The fallback, not the rule: it keeps a demo on screen for a row composed
    // before the field existed, or one whose prototype has since been deleted. A
    // prototype is context a reviewer looks at rather than something the row is
    // scored on, so a stale pointer here costs a demo, not the meaning of a ballot.
    const named = collectOneRow(['prfaq-1'], prfaqWithTwoPrototypes, '')
    const deleted = collectOneRow(['prfaq-1'], prfaqWithTwoPrototypes, 'proto-gone')

    expect(onlyItem(named, 'the row naming none').prototype?.document_id).toBe('proto-new')
    expect(onlyItem(deleted, 'the row naming a deleted one').prototype?.document_id).toBe('proto-new')
  })

  it('gives a project with no prototype no prototype, rather than another project one', () => {
    const rows = collectRows(
      { 'row-1': storedRow('row-1', 'p1', ['prfaq-1']) },
      [
        { documents: [doc('prfaq-1', 'prfaq', 'A', '2025-01-01')] },
        { documents: [doc('proto-1', 'prototype', 'Other Proto', '2025-02-01')] },
      ],
      [project('p1', 'P1'), project('p2', 'P2')],
    )

    expect(onlyItem(rows, 'the row').prototype).toBeUndefined()
  })

  it('carries the row own frozen state through to the view, both ways', () => {
    // The row's composition controls are decided by this, so it has to survive the
    // whole boundary: the wire record, `RowSchema`, and the resolution against the
    // documents on screen. Nothing on this page can DERIVE it — the read carries only
    // the caller's own ballots, so a row somebody else has voted on looks unballoted
    // from here — which is why a dropped field would read as editable.
    const details = [{ documents: [doc('prfaq-1', 'prfaq', 'A', '2025-01-01')] }]
    const projects = [project('p1', 'P1')]

    const frozen = collectRows(
      { 'row-1': storedRow('row-1', 'p1', ['prfaq-1'], '', true) },
      details, projects,
    )
    const editable = collectRows(
      { 'row-1': storedRow('row-1', 'p1', ['prfaq-1'], '', false) },
      details, projects,
    )

    expect(onlyItem(frozen, 'the frozen row').is_frozen).toBe(true)
    expect(onlyItem(editable, 'the editable row').is_frozen).toBe(false)
  })

  it('carries whether the row is the project default through to the view, both ways', () => {
    // The delete control is withheld for a project's ONLY default row, which the API
    // refuses with 409 — so a dropped field would either offer an action that cannot
    // work or hide one that can. Nothing on this page can derive it: "default" is a fact
    // about how the row came to exist, not about what it holds.
    const details = [{ documents: [doc('prfaq-1', 'prfaq', 'A', '2025-01-01')] }]
    const projects = [project('p1', 'P1')]

    const minted = collectRows(
      { 'row-1': storedRow('row-1', 'p1', ['prfaq-1'], '', false, true) },
      details, projects,
    )
    const composed = collectRows(
      { 'row-1': storedRow('row-1', 'p1', ['prfaq-1'], '', false, false) },
      details, projects,
    )

    expect(onlyItem(minted, 'the default row').is_default).toBe(true)
    expect(onlyItem(composed, 'the composed row').is_default).toBe(false)
  })
})

describe('rowsPerProject counts what the delete gate reads', () => {
  /**
   * A STORED row, which is the only shape this takes.
   *
   * `collectRows`' view list is deliberately NOT assignable to the parameter: it drops a
   * row whose documents do not resolve, so counting its output reported a project holding
   * two rows as holding one and the delete gate then said so in words. Narrowing the
   * parameter to the record is what makes that argument a compile error rather than a
   * comment, and these fixtures are the row shape for the same reason.
   */
  const storedRow = (rowId: string, projectId: string): PrioritizationRow => ({
    row_id: rowId,
    project_id: projectId,
    document_ids: ['d1'],
    prototype_id: '',
    is_default: true,
    created_at: '2026-01-01',
    is_frozen: false,
  })

  it('counts each project rows separately', () => {
    const counted = rowsPerProject({
      'row-1': storedRow('row-1', 'p1'),
      'row-2': storedRow('row-2', 'p1'),
      'row-3': storedRow('row-3', 'p2'),
    })

    expect(counted.get('p1')).toBe(2)
    expect(counted.get('p2')).toBe(1)
  })

  it('reports NOTHING for a project with no row, rather than 0', () => {
    // The caller reads an absent count as 1, which is the conservative direction for a
    // courtesy gate — see `isProjectsOnlyDefaultRow`. A stored 0 would let that
    // distinction be lost here instead.
    const counted = rowsPerProject({ 'row-1': storedRow('row-1', 'p1') })

    expect(counted.has('p2')).toBe(false)
    expect(rowsPerProject({}).size).toBe(0)
  })

  it('counts a row whose documents do not resolve, which is why it takes the record', () => {
    // The reachable way a project holding two rows presented as holding one: `collectRows`
    // drops a row not one of whose document ids resolves, an ordinary transient state of
    // the project fan-out. Counting the record itself keeps that sibling in the count.
    const counted = rowsPerProject({
      'row-1': storedRow('row-1', 'p1'),
      'row-2': { ...storedRow('row-2', 'p1'), document_ids: ['gone'] },
    })

    expect(counted.get('p1')).toBe(2)
  })
})

describe('withoutRow drops what a deleted row leaves behind', () => {
  it('removes the named row and keeps every other', () => {
    // THE WRITE THIS EXISTS FOR. `api_patch_prioritization_scores` checks every named
    // row exists before its first write and raises on any miss, so a pending edit left
    // on a deleted row refuses the WHOLE body — losing the edits on rows nobody touched.
    const edits = { 'row-1': { row_id: 'row-1' }, 'row-2': { row_id: 'row-2' } }

    expect(withoutRow(edits, 'row-1')).toStrictEqual({ 'row-2': { row_id: 'row-2' } })
  })

  it('answers the SAME object when it never held the row', () => {
    // Identity, not equality: this runs inside a state updater, and a fresh object for a
    // removal that removed nothing would re-render the page on every settled delete of a
    // row nobody had edited.
    const edits = { 'row-1': { row_id: 'row-1' } }

    expect(withoutRow(edits, 'row-2')).toBe(edits)
  })
})

describe('retainedEnsuredRows lets a successful read settle what exists', () => {
  // `ensuredRows` used to be sticky for the whole mount, so the merge could only ADD a
  // row. With deletion that leaves a removed row on screen until a remount — a delete
  // that reported success and changed nothing visible.

  const ensured = {
    'row-1': storedRow('row-1', 'p1', ['prd-1']),
    'row-2': storedRow('row-2', 'p2', ['prd-2']),
  }

  it('drops an ensured row a published read no longer names', () => {
    const retained = retainedEnsuredRows(ensured, {
      'row-1': storedRow('row-1', 'p1', ['prd-1']),
    })

    expect(Object.keys(retained)).toStrictEqual(['row-1'])
  })

  it('drops every ensured row when a published read names none', () => {
    // An EMPTY published map is authoritative like any other: after the last row of a
    // deployment is deleted, "the partition holds nothing" is the true answer, and
    // treating it as "the read added nothing" is what kept the deleted rows up.
    expect(retainedEnsuredRows(ensured, {})).toStrictEqual({})
  })

  it('keeps every ensured row while no read has said anything', () => {
    // The fallback phase 1 exists for, unchanged: the query still running, a failed one
    // with nothing cached, a response whose rows could not be read, and a deployment
    // sending no `rows` field at all all arrive here as `undefined`. Rows ARE this
    // page's content, so reconciling against silence would empty it on a 500.
    expect(retainedEnsuredRows(ensured, undefined)).toStrictEqual(ensured)
  })

  it('keeps an ensured row the read confirms, unchanged', () => {
    // The positive control: reconciliation must not drop a row that is still there,
    // which is what makes the fallback worth anything at all.
    const retained = retainedEnsuredRows(ensured, ensured)

    expect(Object.keys(retained).sort(byLocale)).toStrictEqual(['row-1', 'row-2'])
  })
})

describe('scorableDocumentsByProject offers what the routes accept', () => {
  it('offers a project PRDs and PR/FAQs, and never its prototype or research', () => {
    // The candidate set the compose and recompose routes validate against
    // (`_scorable_document_ids`): a prototype is context a reviewer looks at rather
    // than something a row is scored on, and the route refuses one in `document_ids`,
    // so offering it would invite a 404 the reviewer cannot act on.
    const byProject = scorableDocumentsByProject(
      [{
        documents: [
          doc('prd-1', 'prd', 'PRD', '2025-01-01'),
          doc('prfaq-1', 'prfaq', 'PR/FAQ', '2025-01-02'),
          doc('proto-1', 'prototype', 'Proto', '2025-01-03'),
          doc('research-1', 'research', 'Research', '2025-01-04'),
        ],
      }],
      [project('p1', 'P1')],
    )

    expect(byProject.get('p1')?.map((d) => d.document_id)).toStrictEqual(['prd-1', 'prfaq-1'])
  })

  it('keeps each project own documents apart, and omits one with nothing scorable', () => {
    // Ownership is the routes' trust boundary — a row is a PROJECT's set of documents,
    // and an id from elsewhere would put another project's document inside this
    // project's team score. A project with nothing scorable gets NO entry rather than
    // an empty list, so `undefined` and `[]` cannot come to mean different things.
    const byProject = scorableDocumentsByProject(
      [
        { documents: [doc('prd-1', 'prd', 'A', '2025-01-01')] },
        { documents: [doc('proto-2', 'prototype', 'B', '2025-01-01')] },
      ],
      [project('p1', 'P1'), project('p2', 'P2')],
    )

    expect(byProject.get('p1')?.map((d) => d.document_id)).toStrictEqual(['prd-1'])
    expect(byProject.has('p2')).toBe(false)
  })

  it('offers nothing while the project reads are missing', () => {
    expect(scorableDocumentsByProject(undefined, undefined).size).toBe(0)
    expect(scorableDocumentsByProject([], []).size).toBe(0)
  })
})
