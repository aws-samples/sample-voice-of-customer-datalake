import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { newestRelease, semverParts, versionProblems } from './check-version.mjs'

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
