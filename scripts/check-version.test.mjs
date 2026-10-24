import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { newestRelease, releaseOrderProblems, semverParts, versionProblems } from './check-version.mjs'

const CHANGELOG = `# Changelog

## [Unreleased]

## [2.09.00] - 2026-10-05

### Added

## [2.08.00] - 2026-10-05

## [0.3.0] - 2026-09-10
`
const pkg = (version, path = 'package.json') => ({ path, version })

test('reads the first dated release under Unreleased, with two-digit minor and patch', () => {
  assert.deepEqual(newestRelease(CHANGELOG), [2, 9, 0])
})

test('no problems when every package carries the release in strict SemVer', () => {
  assert.deepEqual(versionProblems(CHANGELOG, [pkg('2.9.0'), pkg('2.9.0', 'voc-datalake/package.json')]), [])
})

test('names the package that was not bumped and the expected value', () => {
  assert.deepEqual(versionProblems(CHANGELOG, [pkg('2.9.0'), pkg('2.8.0', 'voc-datalake/frontend/package.json')]), [
    'voc-datalake/frontend/package.json is 2.8.0, but CHANGELOG.md\'s newest release is 2.09.00 (expected "2.9.0")',
  ])
})

test('a package ahead of the changelog is a problem too (entry missing)', () => {
  assert.equal(versionProblems(CHANGELOG, [pkg('2.10.0')]).length, 1)
})

test('refuses a changelog whose newest heading is undated or not zero-padded', () => {
  assert.throws(() => newestRelease('## [Unreleased]\n\n## [2.9.0] - 2026-10-05\n'), /no release heading/)
  assert.throws(() => newestRelease('## [Unreleased]\n\n## [2.09.00]\n'), /no release heading/)
})

test('refuses a package.json version that is not strict SemVer', () => {
  assert.throws(() => semverParts('2.09.00x', 'package.json'), /not MAJOR\.MINOR\.PATCH/)
  assert.throws(() => semverParts(undefined, 'package.json'), /not MAJOR\.MINOR\.PATCH/)
})

const withNewest = (newest, older) => `# Changelog\n\n## [Unreleased]\n\n## [${newest}] - 2026-10-08\n\n${older
  .map((v) => `## [${v}] - 2026-10-01\n`)
  .join('\n')}`

test('a newest release above every older section is in order', () => {
  assert.deepEqual(releaseOrderProblems(CHANGELOG), [])
})

test('historical out-of-order sections BELOW the newest stay valid', () => {
  // 3.00.03 was cut after 3.01.00 — released sections are never renumbered.
  assert.deepEqual(releaseOrderProblems(withNewest('3.02.00', ['3.00.03', '3.01.00', '3.00.02'])), [])
})

test('a newest release numbered below an older section fails, naming both', () => {
  assert.deepEqual(releaseOrderProblems(withNewest('3.05.06', ['3.08.04', '3.05.05'])), [
    "CHANGELOG.md's newest release 3.05.06 is not above 3.08.04, which is already in the file: " +
      'number the new release from the highest version (3.08.04), never below it',
  ])
})

test('a newest release equal to an older section fails too', () => {
  assert.equal(releaseOrderProblems(withNewest('3.08.04', ['3.08.04'])).length, 1)
})

test('the comparison is numeric, not textual, and reads old unpadded headings', () => {
  assert.deepEqual(releaseOrderProblems(withNewest('2.10.00', ['2.09.00', '0.3.0'])), [])
  assert.equal(releaseOrderProblems(withNewest('0.10.00', ['0.11.0'])).length, 1)
})

test('only the newest heading is exempt from the comparison, not every heading with its version', () => {
  // A malformed heading above the newest well-formed one is still an "other" section.
  const changelog = '## [Unreleased]\n\n## [9.0.0] - 2026-10-09\n\n## [3.08.05] - 2026-10-08\n'
  assert.equal(releaseOrderProblems(changelog).length, 1)
})

test("the repository's own CHANGELOG.md is in order", () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.deepEqual(releaseOrderProblems(changelog), [])
})
