#!/usr/bin/env node
/**
 * The newest release in CHANGELOG.md must be the version every platform package.json carries.
 *
 * CHANGELOG.md writes releases as `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` with two-digit minor and
 * patch parts (`2.09.00`); npm needs strict SemVer, so package.json carries `2.9.0`. This compares
 * them numerically, and also checks the release heading is well formed and dated, so a change that
 * lands without bumping both (or bumps only one) fails `scripts/validate.sh`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['package.json', 'voc-datalake/package.json', 'voc-datalake/frontend/package.json']
const RELEASE = /^## \[(\d+)\.(\d{2})\.(\d{2})\] - (\d{4}-\d{2}-\d{2})$/m
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** `[major, minor, patch]` of the newest release heading (the first one after `[Unreleased]`). */
export function newestRelease(changelog) {
  const match = RELEASE.exec(changelog)
  if (match === null) {
    throw new Error('CHANGELOG.md has no release heading of the form "## [2.09.00] - 2026-10-05"')
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** `[major, minor, patch]` of a strict SemVer string. */
export function semverParts(version, where) {
  const match = SEMVER.exec(typeof version === 'string' ? version : '')
  if (match === null) throw new Error(`${where}: version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Problems found; empty when every package matches the newest release. */
export function versionProblems(changelog, packages) {
  const release = newestRelease(changelog)
  const shown = `${release[0]}.${String(release[1]).padStart(2, '0')}.${String(release[2]).padStart(2, '0')}`
  const expected = release.join('.')
  return packages
    .filter(({ path, version }) => semverParts(version, path).join('.') !== expected)
    .map(({ path, version }) => `${path} is ${version}, but CHANGELOG.md's newest release is ${shown} (expected "${expected}")`)
}

function main() {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const packages = PACKAGES.map((path) => ({
    path,
    version: JSON.parse(readFileSync(join(ROOT, path), 'utf8')).version,
  }))
  const problems = versionProblems(changelog, packages)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error('Bump every package.json and add the CHANGELOG.md entry together (.kiro/steering/changelog.md).')
    process.exit(1)
  }
  console.log(`version ${packages[0]?.version ?? ''} matches CHANGELOG.md`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
