import { describe, it, expect } from 'vitest'
import { collapseUnchanged, diffLines, MAX_DIFF_CHARS } from './lineDiff'
import type { DiffLine } from './lineDiff'

/** Applying a diff: the `same` + `add` lines must rebuild `after`, `same` + `del` must rebuild `before`. */
function sides(lines: readonly DiffLine[]) {
  return {
    before: lines.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n'),
    after: lines.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n'),
  }
}

function okDiff(before: string, after: string) {
  const result = diffLines(before, after)
  if (result.status !== 'ok') throw new Error('expected a diff')
  return result
}

describe('diffLines', () => {
  it('reports no changes for identical text', () => {
    const r = okDiff('a\nb\nc', 'a\nb\nc')
    expect(r.added).toBe(0)
    expect(r.removed).toBe(0)
    expect(r.lines.every((l) => l.kind === 'same')).toBe(true)
  })

  it('finds a single changed line in the middle', () => {
    const r = okDiff('a\nb\nc', 'a\nB\nc')
    expect(r.lines).toStrictEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('handles empty before and empty after', () => {
    expect(okDiff('', 'x\ny')).toMatchObject({ added: 2, removed: 0 })
    expect(okDiff('x\ny', '')).toMatchObject({ added: 0, removed: 2 })
    expect(okDiff('', '').lines).toStrictEqual([])
  })

  it('treats CRLF like LF', () => {
    expect(okDiff('a\r\nb', 'a\nb')).toMatchObject({ added: 0, removed: 0 })
  })

  it('finds the minimal edit for an insertion between repeated lines', () => {
    const r = okDiff('x\ny\nx\ny', 'x\ny\nNEW\nx\ny')
    expect(r).toMatchObject({ added: 1, removed: 0 })
  })

  it('always reconstructs both sides (property over generated inputs)', () => {
    const alphabet = ['a', 'b', 'c', '', 'd']
    const seeded = (seed: number, n: number) =>
      Array.from({ length: n }, (_, i) => alphabet[(seed * 31 + i * 17 + ((seed + i) % 7)) % alphabet.length]).join('\n')
    for (const seed of Array.from({ length: 60 }, (_, i) => i)) {
      const before = seeded(seed, (seed % 9) + 1)
      const after = seeded(seed + 3, ((seed * 5) % 11) + 1)
      const r = okDiff(before, after)
      expect(sides(r.lines)).toStrictEqual({ before, after })
    }
  })

  it('falls back to too-large instead of building a huge table', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    const other = Array.from({ length: 3000 }, (_, i) => `other ${i}`).join('\n')
    expect(diffLines(big, other)).toStrictEqual({ status: 'too-large' })
    expect(diffLines('x'.repeat(MAX_DIFF_CHARS + 1), 'y')).toStrictEqual({ status: 'too-large' })
  })

  it('stays cheap for a long document with a small edit (prefix/suffix trimming)', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    const edited = [...lines.slice(0, 10_000), 'inserted', ...lines.slice(10_000)]
    expect(okDiff(lines.join('\n'), edited.join('\n'))).toMatchObject({ added: 1, removed: 0 })
  })
})

describe('collapseUnchanged', () => {
  it('keeps context around changes and collapses the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const after = before.map((l, i) => (i === 10 ? 'CHANGED' : l))
    const items = collapseUnchanged(okDiff(before.join('\n'), after.join('\n')).lines, 2)
    expect(items[0]).toStrictEqual({ kind: 'skip', count: 8 })
    expect(items.filter((i) => i.kind === 'same')).toHaveLength(4)
    // l11..l19 follow the del/add pair: 2 kept as context, 7 collapsed.
    expect(items.at(-1)).toStrictEqual({ kind: 'skip', count: 7 })
  })

  it('collapses everything to one skip when nothing changed', () => {
    const r = okDiff('a\nb\nc', 'a\nb\nc')
    expect(collapseUnchanged(r.lines)).toStrictEqual([{ kind: 'skip', count: 3 }])
  })
})
