/**
 * One project read is indexed ONCE for every row and every lineage rule asked
 * about it (issue #399 B).
 *
 * COUNTED, NEVER TIMED, and that is the whole reason this file exists rather than
 * an assertion inside `prioritizationUtils.test.ts`'s `collectRows` block: the
 * defect was quadratic work, and a wall-clock threshold for it would either pass on
 * a fast machine with the defect restored or fail on a loaded one without it. The
 * countable thing is the number of times `derivationSourceIndex` is CALLED, which is
 * a property of the code and identical on every machine — so the mock below wraps
 * the real builder and changes nothing about the answers.
 *
 * COUNTING THE INDEX BUILDER ALONE WAS NOT ENOUGH, which is the reason the second
 * counter below exists. `vi.mock` replaces the binding OTHER modules import;
 * `resolveDerivation` calls `derivationSourceIndex` through the module-local binding
 * inside `derivation.ts`, which no mock of this module can reach. So the single most
 * likely regression — `hasSupersededSource`/`recordsNoLineage` going back to
 * `resolveDerivation(raw, projectDocuments)`, which is exactly the code #399 B
 * replaces — rebuilt one index per resolver call and still reported
 * `indexBuilds.count === 1` (measured: the whole suite stayed green under that
 * revert). What closes the hole is counting the OTHER side of the seam: every
 * resolution on this page's path must go through `resolveDerivationAgainst`, so
 * `resolveDerivation` must be called ZERO times during `collectRows`, and any route
 * back through it is visible whether or not it happens to rebuild an index.
 *
 * REVERT MAP:
 *
 *  * `collectRows` passing `project.documents` instead of the prepared
 *    `project.lineage` → "indexes a project read once however many rows name it"
 *    (measured: the count goes from 1 to 13 at three rows, one per row per rule);
 *  * `fresherCoherentSelection` passing `projectDocuments` to its nested
 *    `classifySelectionLineage` → the same case (measured: 1 → 2, since one frozen
 *    row's candidate is re-indexed);
 *  * `hasSupersededSource`/`recordsNoLineage` reverted to their pre-#399 B
 *    `resolveDerivation(raw, projectDocuments)` — the faithful `git revert` of the
 *    hot path, with `collectRows`' `projectLineageSources` left in place → "indexes a
 *    project read once however many rows name it", and ONLY via its
 *    `resolveDerivationCalls.count` assertion (measured: 11 calls, expected 0; the
 *    `indexBuilds.count === 1` assertion beside it stays green, which is why that
 *    assertion is not the one this entry names);
 *  * `projectLineageSources` hoisted out of the details loop, or shared between
 *    projects → "indexes each project read separately", which is the assertion that
 *    stops "once" being satisfied by an index built once for the whole page and
 *    handed to every project — a row would then resolve its sources against another
 *    project's documents;
 *  * `lineageSourcesOf` building a fresh index even for a prepared read → both
 *    cases.
 *
 * THE POSITIVE CONTROL each case carries is its lineage assertion, and it is not a
 * formality: a `collectRows` that stopped classifying lineage altogether would also
 * report one construction, or none. So each case first pins the row states the
 * fixture is built to produce — a crossing, a coherent chain and an absent one — and
 * only then the count.
 */
import { describe, it, expect, vi } from 'vitest'
import type { PrioritizationRow, Project, ProjectDocument } from '../../api/types'

/**
 * The real builder and the per-call resolver, each wrapped in a counter.
 *
 * `importOriginal` rather than a stub, following `ScraperCard.test.tsx`: the answers
 * must be the production ones, because the control assertions below read the lineage
 * states this fixture is built to produce. Only the call counts are observed.
 *
 * TWO COUNTERS BECAUSE ONE OF THEM CANNOT SEE INSIDE `derivation.ts`. This mock
 * replaces the bindings other modules import, so `indexBuilds` counts the index
 * builds `rowLineage.ts`/`prioritizationUtils.ts` ask for and NOT the one
 * `resolveDerivation` makes for itself through its module-local binding.
 * `resolveDerivationCalls` covers exactly that blind spot: it is the per-call
 * resolver this optimisation replaces, so on the page's path it must never be
 * reached at all. See the file docstring for the revert that proved one counter
 * insufficient.
 */
const indexBuilds = vi.hoisted(() => ({ count: 0 }))
const resolveDerivationCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../api/derivation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/derivation')>()
  return {
    ...actual,
    derivationSourceIndex: (documents: readonly unknown[]) => {
      indexBuilds.count += 1
      return actual.derivationSourceIndex(documents)
    },
    resolveDerivation: (document: unknown, projectDocuments?: readonly unknown[]) => {
      resolveDerivationCalls.count += 1
      return actual.resolveDerivation(document, projectDocuments)
    },
  }
})

const { collectRows } = await import('./prioritizationUtils')

const project = (projectId: string, name: string): Project => ({
  project_id: projectId,
  name,
  description: '',
  status: 'active',
  created_at: '',
  updated_at: '',
  persona_count: 0,
  document_count: 0,
})

const doc = (
  documentId: string,
  documentType: ProjectDocument['document_type'],
  createdAt: string,
  extra: Record<string, unknown> = {},
): ProjectDocument => ({
  document_id: documentId,
  document_type: documentType,
  title: `${documentType} ${documentId}`,
  content: '',
  created_at: createdAt,
  ...extra,
})

/** A declared derivation naming one source, as `lambda/shared/derivation.py` writes it. */
const builtFrom = (...ids: readonly string[]) => ({
  derivation: {
    sources: ids.map((id) => ({ document_id: id, role: 'reference' })),
    selected_document_count: ids.length,
    feedback_count: 0,
    persona_ids: [],
    visual_document_ids: [],
    product_context_included: false,
  },
})

const storedRow = (
  rowId: string,
  projectId: string,
  documentIds: readonly string[],
  isFrozen = false,
): PrioritizationRow => ({
  row_id: rowId,
  project_id: projectId,
  document_ids: [...documentIds],
  prototype_id: '',
  is_default: true,
  created_at: '2026-01-01',
  is_frozen: isFrozen,
})

/**
 * Documents of ONE project, shaped so the three rows below land in three different
 * lineage states — which is what makes the control assertions distinguishing.
 *
 * `prfaq_1` is built from `prd_1`, and `prd_2` supersedes `prd_1`, so a row holding
 * {prd_2, prfaq_1} crosses generations while {prd_2, prfaq_2} is one chain and
 * {prd_3} (a hand-authored PRD recording nothing) is lineage-absent.
 */
const DOCUMENTS: ProjectDocument[] = [
  doc('prd_1', 'prd', '2025-01-01T09:00:00Z'),
  doc('prfaq_1', 'prfaq', '2025-01-01T09:00:00Z', builtFrom('prd_1')),
  doc('prd_2', 'prd', '2025-02-01T09:00:00Z', builtFrom('prd_1')),
  doc('prfaq_2', 'prfaq', '2025-02-01T09:00:00Z', builtFrom('prd_2')),
  doc('prd_3', 'prd', '2025-03-01T09:00:00Z'),
]

const ROWS: Record<string, PrioritizationRow> = {
  crossing: storedRow('crossing', 'p1', ['prd_2', 'prfaq_1'], true),
  coherent: storedRow('coherent', 'p1', ['prd_2', 'prfaq_2'], true),
  absent: storedRow('absent', 'p1', ['prd_3'], true),
}

/** State and reason per row id, so a control assertion reads as one object. */
const lineageByRow = (rows: ReturnType<typeof collectRows>) => Object.fromEntries(
  rows.map((row) => [row.row_id, `${row.lineage.state}/${row.lineage.reason}`]),
)

describe('collectRows indexes each project read once', () => {
  it('indexes a project read once however many rows name it', () => {
    indexBuilds.count = 0
    resolveDerivationCalls.count = 0

    const rows = collectRows(ROWS, [{ documents: DOCUMENTS }], [project('p1', 'P1')])

    // The control, asserted FIRST: three rows really were classified, in three
    // different states, off the shared index. A `collectRows` that skipped the
    // lineage would report one construction too — or none — so the count below only
    // means something once this holds.
    expect(lineageByRow(rows)).toEqual({
      crossing: 'crossGeneration/supersededSource',
      coherent: 'coherent/oneChain',
      absent: 'absent/noneRecorded',
    })
    // ONE, not "three" and not "one per rule": the three rows, the classifier's two
    // derivation-reading rules, and the frozen rows' candidate classification all
    // read the same index. Before this change the resolver built one per call, so the
    // same fixture built 13.
    expect(indexBuilds.count).toBe(1)
    // ZERO, and this is the assertion the count above cannot make. `resolveDerivation`
    // indexes the project list for ITSELF, through a binding inside `derivation.ts`
    // that no mock of that module reaches — so a rule going back to
    // `resolveDerivation(raw, projectDocuments)` rebuilds an index per resolver call
    // and `indexBuilds.count` still reads 1. Every resolution on this page's path
    // must go through `resolveDerivationAgainst`, which is a property of the code
    // and countable here whether or not the route back happens to re-index.
    expect(resolveDerivationCalls.count).toBe(0)
  })

  it('indexes each project read separately', () => {
    // The other direction, and the reason "once" is not enough on its own: an index
    // built once for the WHOLE page would satisfy the case above while resolving one
    // project's sources against another project's documents. Two projects, so the
    // count tracks project reads rather than being pinned at 1.
    indexBuilds.count = 0
    const second = [doc('prd_9', 'prd', '2025-01-01T09:00:00Z', builtFrom('prd_1'))]

    const rows = collectRows(
      { ...ROWS, other: storedRow('other', 'p2', ['prd_9'], true) },
      [{ documents: DOCUMENTS }, { documents: second }],
      [project('p1', 'P1'), project('p2', 'P2')],
    )

    // The control: `prd_9` names `prd_1` as its source, which project 2 does NOT
    // hold — so it resolves against project 2's own index and stays unresolved,
    // reading `coherent` rather than crossing with project 1's PRD.
    expect(lineageByRow(rows).other).toBe('coherent/oneChain')
    expect(indexBuilds.count).toBe(2)
  })

  it('builds nothing for a page whose project reads have not landed', () => {
    // The floor: no project read, no index. Pins that the builder moved into the
    // details loop rather than being called unconditionally per page render.
    indexBuilds.count = 0

    expect(collectRows(ROWS, undefined, undefined)).toStrictEqual([])
    expect(indexBuilds.count).toBe(0)
  })
})
