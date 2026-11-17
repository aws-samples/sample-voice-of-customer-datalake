/**
 * @fileoverview The Changes tab's diff parser: git's headers (index, modes, new and deleted files against
 * `/dev/null`), renames and copies, binary files, `\ No newline at end of file`, quoted paths, a plain patch with no git
 * header, the file a header names, the fold of long unchanged runs and the split view's rows.
 */
import { describe, expect, it } from 'vitest'
import { extractFilePath, foldContext, modeChangeKind, parseUnifiedDiff, splitRows } from './unifiedDiff'
import fixture from '@test/engineeringRunWorkspace.json'

const MODIFIED = [
  'diff --git a/src/paging.py b/src/paging.py',
  'index 3b18e51..a9c4f02 100644',
  '--- a/src/paging.py',
  '+++ b/src/paging.py',
  '@@ -10,2 +10,3 @@ def last_page(items, size):',
  '     start = 1',
  '--    return items[start:start + size + 1]',
  '+    return items[start:start + size]',
  '+++ added line that looks like a header',
].join('\n')

const ADDED_AND_DELETED = [
  'diff --git a/tests/test_paging.py b/tests/test_paging.py',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/tests/test_paging.py',
  '@@ -0,0 +1,2 @@',
  '+def test_the_last_page():',
  '+    assert True',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
].join('\n')

const RENAMED_AND_BINARY = [
  'diff --git a/docs/old-paging.md b/docs/paging.md',
  'similarity index 90%',
  'rename from docs/old-paging.md',
  'rename to docs/paging.md',
  '--- a/docs/old-paging.md',
  '+++ b/docs/paging.md',
  '@@ -1 +1 @@',
  '-Paging',
  '+Paging, at most a page',
  'diff --git a/bin/run b/bin/run',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1234567..89abcde 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git "a/my file.txt" "b/my file.txt"',
  'copy from "a\\tb.txt"',
  'copy to "my file.txt"',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('reads a modified file, its numbered lines, and content that looks like a header', () => {
    const [file] = parseUnifiedDiff(MODIFIED)
    expect([file?.path, file?.status, file?.oldPath, file?.additions, file?.deletions]).toStrictEqual(['src/paging.py', 'modified', null, 2, 1])
    expect(file?.hunks[0]?.lines.map((line) => [line.kind, line.oldNo, line.newNo, line.text])).toStrictEqual([
      ['context', 10, 10, '    start = 1'],
      ['del', 11, null, '-    return items[start:start + size + 1]'],
      ['add', null, 11, '    return items[start:start + size]'],
      ['add', null, 12, '++ added line that looks like a header'],
    ])
  })

  it('reads an added file against /dev/null, its missing final newline, and a deleted one', () => {
    const files = parseUnifiedDiff(ADDED_AND_DELETED)
    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toStrictEqual([
      ['tests/test_paging.py', 'added', 2, 0], ['old.txt', 'deleted', 0, 1],
    ])
    expect(files[0]?.hunks[0]?.lines.map((line) => line.noNewline)).toStrictEqual([false, true])
  })

  it('reads a rename with its old path, a mode change, a binary file and a quoted copy', () => {
    const files = parseUnifiedDiff(RENAMED_AND_BINARY)
    expect(files.map((file) => [file.path, file.oldPath, file.status, file.binary])).toStrictEqual([
      ['docs/paging.md', 'docs/old-paging.md', 'renamed', false],
      ['bin/run', null, 'modified', false],
      ['assets/logo.png', null, 'modified', true],
      ['my file.txt', 'a\tb.txt', 'copied', false],
    ])
    expect(files[1]?.modeChange).toStrictEqual({ from: '100644', to: '100755' })
  })

  it('reads a plain patch with no git header, its paths ending at the tab before a timestamp', () => {
    const files = parseUnifiedDiff(['--- a.txt\t2026-11-17', '+++ a.txt\t2026-11-17', '@@ -1 +1 @@', '-x', '+y', '--- b.txt', '+++ b.txt', '@@ -1 +1 @@', '-p', '+q'].join('\n'))
    expect(files.map((file) => [file.path, file.additions, file.deletions])).toStrictEqual([['a.txt', 1, 1], ['b.txt', 1, 1]])
  })

  it('reads the shared fixture\'s file part, its trimmed empty context lines kept', () => {
    const [file] = parseUnifiedDiff(fixture.change_file.answer.patch)
    expect([file?.path, file?.additions, file?.deletions, file?.hunks[0]?.lines.length]).toStrictEqual(['src/paging.py', 1, 1, 8])
  })
})

describe('extractFilePath', () => {
  it.each([
    ['+++ b/ wins', '--- a/old.py\n+++ b/new.py\n', 'new.py'],
    ['the old side for a deletion', '--- a/gone.py\n+++ /dev/null\n', 'gone.py'],
    ['a space inside the path, the tab ending it', '+++ b/report final.md\t2026-11-17\n', 'report final.md'],
    ['nothing after the first hunk', 'diff --git a/x b/x\n@@ -1 +1 @@\n+++ b/inside.py\n', 'x'],
    ['none at all', 'just text\n', null],
  ])('%s', (_name, code, path) => {
    expect(extractFilePath(code)).toBe(path)
  })
})

describe('modeChangeKind', () => {
  it('names the executable bit, and any other mode change as one', () => {
    expect([
      modeChangeKind({ from: '100644', to: '100755' }), modeChangeKind({ from: '100755', to: '100644' }),
      modeChangeKind({ from: '100644', to: '120000' }), modeChangeKind({ from: '100644', to: '100664' }),
    ]).toStrictEqual(['executable', 'notExecutable', 'changed', 'changed'])
  })
})

describe('foldContext', () => {
  const lines = (kinds: string) => kinds.split('').map((kind, index) => ({
    kind: kind === '+' ? 'add' as const : 'context' as const, text: String(index), oldNo: index, newNo: index, noNewline: false,
  }))

  it('folds a long unchanged run between changes, three lines kept beside each', () => {
    const segments = foldContext(lines('+' + ' '.repeat(12) + '+'))
    expect(segments.map((segment) => [segment.kind, segment.lines.length])).toStrictEqual([['lines', 4], ['fold', 6], ['lines', 4]])
  })

  it('keeps only the side beside a change at a hunk\'s edge, and folds nothing short', () => {
    expect(foldContext(lines(' '.repeat(10) + '+')).map((segment) => [segment.kind, segment.lines.length])).toStrictEqual([['fold', 7], ['lines', 4]])
    expect(foldContext(lines('+     +')).map((segment) => segment.kind)).toStrictEqual(['lines'])
  })
})

describe('splitRows', () => {
  it('puts removals beside the additions after them, and unchanged lines on both sides', () => {
    const [file] = parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1,4 +1,4 @@', ' a', '-b', '-c', '+B', ' d', '+e'].join('\n'))
    const rows = splitRows(file?.hunks[0]?.lines ?? [])
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toStrictEqual([
      ['a', 'a'], ['b', 'B'], ['c', null], ['d', 'd'], [null, 'e'],
    ])
  })
})
