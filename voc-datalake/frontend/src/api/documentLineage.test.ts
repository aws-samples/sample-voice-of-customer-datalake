/**
 * `ordinalByType` and `resolveRevision` — the two lineage facts nothing stores.
 *
 * Every fixture holds at least TWO documents of a type, because the live project
 * that motivated this has three PR/FAQs and six prototypes all titled
 * "Prototype": a single-document fixture cannot tell "numbered correctly" from
 * "numbered at all".
 */
import { describe, it, expect } from 'vitest'
import { isVersionManagedDocument, ordinalByType, resolveRevision } from './documentLineage'

const OLDER = { document_id: 'zz_prd_old', document_type: 'prd', title: 'Spec', created_at: '2026-01-01T00:00:00Z' }
const NEWER = { document_id: 'aa_prd_new', document_type: 'prd', title: 'Spec', created_at: '2026-06-01T00:00:00Z' }

describe('isVersionManagedDocument', () => {
  it.each(['prd', 'prfaq', 'prototype'])('recognizes the current %s type', (documentType) => {
    expect(isVersionManagedDocument({ document_type: documentType })).toBe(true)
  })

  it.each(['PRD#legacy', 'PRFAQ#legacy', 'PROTOTYPE#legacy'])(
    'recognizes the legacy %s sort-key prefix when type metadata is absent',
    (sortKey) => {
      expect(isVersionManagedDocument({ sk: sortKey })).toBe(true)
    },
  )

  it.each([
    { document_type: 'research' },
    { document_type: 'custom' },
    { document_type: 'product_report' },
    { sk: 'RESEARCH#legacy' },
    { sk: 'prototype#wrong-case' },
    null,
    [],
  ])('does not classify an unmanaged or malformed value as managed', (document) => {
    expect(isVersionManagedDocument(document)).toBe(false)
  })
})

describe('ordinalByType', () => {
  it('numbers documents of a type oldest first, regardless of id order', () => {
    // Ids are deliberately reverse-alphabetical to creation order: numbering by
    // id would label the older document 2.
    const ordinals = ordinalByType([NEWER, OLDER])

    expect(ordinals.get('zz_prd_old')).toEqual({ ordinal: 1, total: 2 })
    expect(ordinals.get('aa_prd_new')).toEqual({ ordinal: 2, total: 2 })
  })

  it('keeps a document’s number when a newer sibling is added', () => {
    // Why oldest-first: "PRD 1" must mean the same document next week. Numbering
    // newest-first would renumber every existing document on each generation, so
    // a review comment naming "PRD 2" would rot immediately.
    const before = ordinalByType([OLDER, NEWER])
    const after = ordinalByType([OLDER, NEWER, {
      document_id: 'mm_prd_newest', document_type: 'prd', title: 'Spec', created_at: '2026-09-01T00:00:00Z',
    }])

    expect(before.get('zz_prd_old')?.ordinal).toBe(1)
    expect(after.get('zz_prd_old')?.ordinal).toBe(1)
    expect(after.get('aa_prd_new')?.ordinal).toBe(2)
    expect(after.get('zz_prd_old')?.total).toBe(3)
  })

  it('counts each type separately', () => {
    const ordinals = ordinalByType([
      OLDER, NEWER,
      { document_id: 'prfaq_1', document_type: 'prfaq', title: 'Launch', created_at: '2026-02-01T00:00:00Z' },
    ])

    expect(ordinals.get('prfaq_1')).toEqual({ ordinal: 1, total: 1 })
    expect(ordinals.get('aa_prd_new')?.total).toBe(2)
  })

  it('breaks a tie on created_at using document_id, matching the backend', () => {
    // Four prototypes sharing one date is the real case. The backend picks "the
    // newest of a type" on (created_at, document_id), so the highest ordinal here
    // must be the document a default build reads — otherwise the row says 4 of 4
    // while the build uses a different one.
    const sameDay = '2026-07-10T00:00:00Z'
    const ordinals = ordinalByType([
      { document_id: 'p_b', document_type: 'prototype', title: 'Prototype', created_at: sameDay },
      { document_id: 'p_a', document_type: 'prototype', title: 'Prototype', created_at: sameDay },
    ])

    expect(ordinals.get('p_a')?.ordinal).toBe(1)
    expect(ordinals.get('p_b')?.ordinal).toBe(2)
  })

  it('does not let an unusable entry inflate a total', () => {
    // A total is rendered to the user ("2 of 3"), so a junk entry counted into it
    // would make the UI claim a document that cannot be opened.
    const ordinals = ordinalByType([OLDER, NEWER, null, 'nonsense', [], { document_type: 'prd' }])

    expect(ordinals.get('zz_prd_old')?.total).toBe(2)
    expect(ordinals.size).toBe(2)
  })

  it('skips an entry with an id but no usable type', () => {
    // Added in review round 2: the id-less case was covered, this one was not.
    // Without the type guard such records all group under '', so unrelated
    // malformed documents would share one sequence and inflate each other.
    const ordinals = ordinalByType([
      OLDER, NEWER,
      { document_id: 'typeless_1', created_at: '2026-03-01T00:00:00Z' },
      { document_id: 'typeless_2', document_type: 42, created_at: '2026-04-01T00:00:00Z' },
    ])

    expect(ordinals.size).toBe(2)
    expect(ordinals.get('typeless_1')).toBeUndefined()
    expect(ordinals.get('zz_prd_old')?.total).toBe(2)
  })

  it('returns an empty map for no documents', () => {
    expect(ordinalByType([]).size).toBe(0)
  })
})

describe('resolveRevision', () => {
  const base = { document_id: 'proto_1', document_type: 'prototype', title: 'First cut', created_at: '2026-08-01T00:00:00Z' }
  const revision = {
    document_id: 'proto_2',
    document_type: 'prototype',
    title: 'First cut',
    created_at: '2026-08-08T00:00:00Z',
    revised_from_id: 'proto_1',
    revision_feedback: 'Show the admin perspective',
  }

  it('names the document a revision was made from, and the feedback that drove it', () => {
    expect(resolveRevision(revision, [base, revision])).toEqual({
      revisedFromId: 'proto_1',
      title: 'First cut',
      resolved: true,
      feedback: 'Show the admin perspective',
    })
  })

  it('keeps the relation when the revised document has been deleted', () => {
    // Same rule the derivation footer follows: the relation outlived its target,
    // so it is still reported — just not as something to navigate to.
    const resolved = resolveRevision(revision, [revision])

    expect(resolved?.resolved).toBe(false)
    expect(resolved?.title).toBeNull()
    expect(resolved?.revisedFromId).toBe('proto_1')
  })

  it('returns null for a document that is not a revision', () => {
    expect(resolveRevision(base, [base])).toBeNull()
  })

  it('treats a stored null exactly like an absent field', () => {
    // The backend writes `revised_from_id: base_prototype_id or None`, so null is
    // a REAL stored value on any revision started without a base.
    const storedNull = resolveRevision({ ...base, revised_from_id: null }, [base])
    const absent = resolveRevision(base, [base])

    expect(storedNull).toBeNull()
    expect(storedNull).toEqual(absent)
  })

  it('reports a revision with no recorded feedback as an empty string', () => {
    const resolved = resolveRevision({ ...revision, revision_feedback: undefined }, [base])

    expect(resolved?.feedback).toBe('')
    expect(resolved?.resolved).toBe(true)
  })

  it('never throws on an unreadable document', () => {
    for (const value of [null, undefined, 'a string', 42, [], { revised_from_id: 7 }]) {
      expect(resolveRevision(value, [base])).toBeNull()
    }
  })

  it('is inert on a cycle, because it only ever reads one step', () => {
    // A pair that revises each other cannot loop: each call returns the other
    // once. Depth-1 is what makes a chain the caller's decision rather than a
    // traversal that has to defend itself.
    const a = { document_id: 'a', title: 'A', revised_from_id: 'b' }
    const b = { document_id: 'b', title: 'B', revised_from_id: 'a' }

    expect(resolveRevision(a, [a, b])?.revisedFromId).toBe('b')
    expect(resolveRevision(b, [a, b])?.revisedFromId).toBe('a')
  })

  it('resolves against the supplied list only, so no documents means unresolved', () => {
    expect(resolveRevision(revision)).toEqual({
      revisedFromId: 'proto_1',
      title: null,
      resolved: false,
      feedback: 'Show the admin perspective',
    })
  })
})
