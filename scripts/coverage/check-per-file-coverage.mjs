#!/usr/bin/env node
/**
 * Per-file coverage ratchet: every measured production file reaches the suite's floor (a line rate), except the
 * files its baseline lists, and the baseline only ever shrinks (docs/coverage-gate.md).
 *
 * Why: a total percentage hides a new, untested file behind a large, well-tested one, and the suites had no
 * threshold at all, so coverage could fall without anyone seeing it. A per-file floor makes every new file carry
 * its own tests; the baseline records the files that were under the floor when the gate started, at the rate
 * they had then.
 *
 * It fails (exit 1) when:
 *   (a) a file NOT in the baseline is below the floor;
 *   (b) a baselined file fell below its recorded rate (minus EPSILON);
 *   (c) a baseline row is stale: its file is gone from the report (deleted, renamed, no longer measured), has
 *       nothing to measure, or now reaches the floor. `--update-baseline` deletes those rows.
 * It cannot run (exit 2) on any malformed input: an unreadable or wrongly shaped report, an empty report, a
 * report path outside the repository, a malformed, unsorted or duplicated baseline row. It fails closed.
 *
 * Reads coverage.py JSON (`--format py`: `files[path].summary`, statements) or vitest's v8 `json-summary`
 * (`--format vitest`: `coverage-summary.json`, lines). A file with nothing to measure (0 statements) is skipped.
 *
 *   node scripts/coverage/check-per-file-coverage.mjs --suite <python|frontend|stream> [--update-baseline | --init]
 *   node scripts/coverage/check-per-file-coverage.mjs --format py|vitest --report <f> --baseline <f> --floor <n>
 *        [--base <dir>] [--update-baseline | --init]
 *
 * --suite reads scripts/coverage/suites.json, the ONE place each suite's floor is set (human-owned).
 * --update-baseline only DELETES rows (stale, as in (c)); every surviving line is copied verbatim, and it can never
 *   add a path or rewrite a rate. --init writes a new baseline (every file now under the floor) and refuses when
 *   the file exists: it is for the gate's first run, not for accepting new uncovered files.
 *
 * Limits: it judges line/statement rates only (not branches), and only the files the report lists, so what is
 * measured is decided by each tool's include/exclude configuration (scripts/coverage/python.coveragerc, the
 * `coverage` blocks of the vitest configs). A report is trusted to come from the run just made: the gate step
 * deletes the old one before the suite runs. A renamed file is a new path to it, so a rename keeps the file at
 * the floor or the owner decides.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SUITES_FILE = join(ROOT, 'scripts', 'coverage', 'suites.json')
/**
 * A baselined file may sit this many points under its recorded rate. Rates are recorded truncated to two decimals,
 * so the tolerance is not needed for rounding of the figure itself; it absorbs the small moves a refactor of a
 * baselined file makes in its line count (one uncovered line in a 1,000-line file is 0.1 point) without letting a
 * real drop through.
 */
export const EPSILON = 0.1
const ROW = /^(\S+)\s+(\d{1,3}(?:\.\d{1,2})?)(?:\s+#.*)?$/

export class InputError extends Error {}

const isCount = (value) => Number.isInteger(value) && value >= 0

/** Line rate in percent, truncated to two decimals (integer arithmetic, so 2/3 is 66.66, never 66.67). */
export function rateOf(covered, total) {
  return Math.floor((covered * 10000) / total) / 100
}

/** A report key as a repo-relative POSIX path; throws when it points outside the repository. */
export function normalisePath(key, { repoRoot, base }) {
  const rel = relative(repoRoot, resolve(repoRoot, base, key))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new InputError(`report path ${JSON.stringify(key)} is outside the repository`)
  }
  return rel.split(sep).join('/')
}

function countsOf(format, key, entry) {
  const counts = format === 'py'
    ? { covered: entry?.summary?.covered_lines, total: entry?.summary?.num_statements }
    : { covered: entry?.lines?.covered, total: entry?.lines?.total }
  if (!isCount(counts.covered) || !isCount(counts.total) || counts.covered > counts.total) {
    throw new InputError(`report entry ${JSON.stringify(key)} has no valid covered/total line counts`)
  }
  return counts
}

function reportEntries(format, data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InputError('report is not a JSON object')
  }
  if (format === 'py') {
    if (data.files === null || typeof data.files !== 'object' || Array.isArray(data.files)) {
      throw new InputError('coverage.py report has no "files" object (expected `coverage json` output)')
    }
    return Object.entries(data.files)
  }
  if (format === 'vitest') {
    if (!('total' in data)) throw new InputError('vitest report has no "total" entry (expected the json-summary reporter)')
    return Object.entries(data).filter(([key]) => key !== 'total')
  }
  throw new InputError(`unknown --format ${JSON.stringify(format)} (py or vitest)`)
}

/** Map of repo-relative path -> {covered, total} for every file the report lists. */
export function parseReport(format, text, paths) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new InputError(`report is not valid JSON: ${error.message}`)
  }
  const files = new Map()
  for (const [key, entry] of reportEntries(format, data)) {
    const path = normalisePath(key, paths)
    if (files.has(path)) throw new InputError(`report lists ${path} twice`)
    files.set(path, countsOf(format, key, entry))
  }
  if (files.size === 0) throw new InputError('report lists no files (did the suite run with coverage on?)')
  return files
}

/** Rows of a baseline file: [{path, rate, line}], in file order. Comment and blank lines are not rows. */
export function parseBaseline(text) {
  const rows = []
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    const match = ROW.exec(trimmed)
    const rate = match === null ? NaN : Number(match[2])
    if (match === null || rate > 100 || match[1].includes('\\') || match[1].startsWith('/')) {
      throw new InputError(`baseline line ${index + 1} is not "<repo-relative path> <rate>   # <covered>/<total>": ${line}`)
    }
    const previous = rows.at(-1)
    if (previous !== undefined && !(previous.path < match[1])) {
      const problem = previous.path === match[1] ? 'repeats' : 'is out of order after'
      throw new InputError(`baseline line ${index + 1}: ${match[1]} ${problem} ${previous.path} (rows are sorted by path)`)
    }
    rows.push({ path: match[1], rate, line })
  })
  return rows
}

/** Findings of one check: {belowFloor, regressed, stale} (each a list of messages), plus the stale paths. */
export function evaluate(files, rows, floor) {
  const baselined = new Map(rows.map((row) => [row.path, row]))
  const belowFloor = []
  const regressed = []
  const stale = []
  const stalePaths = new Set()
  const markStale = (path, why) => { stale.push(`${path}: ${why}`); stalePaths.add(path) }
  for (const [path, { covered, total }] of files) {
    if (total === 0) {
      if (baselined.has(path)) markStale(path, 'nothing to measure any more')
      continue
    }
    const rate = rateOf(covered, total)
    const row = baselined.get(path)
    if (row === undefined) {
      if (rate < floor) belowFloor.push(`${path}: ${rate.toFixed(2)}% (${covered}/${total}) is below the ${floor}% floor`)
    } else if (rate < row.rate - EPSILON) {
      regressed.push(`${path}: ${rate.toFixed(2)}% (${covered}/${total}) fell below its recorded ${row.rate.toFixed(2)}%`)
    } else if (rate >= floor) {
      markStale(path, `reaches the floor now (${rate.toFixed(2)}%): graduated`)
    }
  }
  for (const row of rows) {
    if (!files.has(row.path)) markStale(row.path, 'not in the report (deleted, renamed or no longer measured)')
  }
  return { belowFloor, regressed, stale, stalePaths }
}

/** The baseline text without the stale rows; every other line (header included) is kept byte for byte. */
export function shrinkBaseline(text, stalePaths) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return true
      return !stalePaths.has(trimmed.split(/\s+/)[0])
    })
    .join('\n')
}

/** A first baseline: a header explaining the rule, then one row per file now below the floor, sorted by path. */
export function initBaseline(files, floor, refresh) {
  const rows = [...files]
    .filter(([, { total }]) => total > 0)
    .map(([path, { covered, total }]) => ({ path, covered, total, rate: rateOf(covered, total) }))
    .filter(({ rate }) => rate < floor)
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const header = [
    '# Per-file coverage baseline (docs/coverage-gate.md). Every measured production file must reach the floor',
    '# (scripts/coverage/suites.json) unless it is listed here; a listed file must not fall below the rate it had',
    '# when it was recorded. This file only ever SHRINKS: add tests to a listed file until it reaches the floor,',
    '# then run this, which deletes graduated and vanished rows and never adds one:',
    `#   ${refresh}`,
    '# A new or renamed file is a new path: it reaches the floor, or the owner decides. Do not edit rates by hand.',
    '# Format: <repo-relative path> <line rate when recorded>   # <covered>/<total>',
  ]
  const body = rows.map(({ path, rate, covered, total }) => `${path} ${rate.toFixed(2)}   # ${covered}/${total}`)
  return `${[...header, ...body].join('\n')}\n`
}

const FLAGS = new Set(['--suite', '--format', '--report', '--baseline', '--floor', '--base'])
const SWITCHES = new Set(['--update-baseline', '--init'])

/** Command-line options; --suite fills in the rest from suites.json and cannot be mixed with them. */
export function parseArgs(argv, suites) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (SWITCHES.has(arg)) options[arg.slice(2)] = true
    else if (FLAGS.has(arg) && i + 1 < argv.length) { options[arg.slice(2)] = argv[i + 1]; i += 1 }
    else throw new InputError(`unknown or incomplete option ${JSON.stringify(arg)} (see the header of this script)`)
  }
  if (options['update-baseline'] && options.init) throw new InputError('--update-baseline and --init are exclusive')
  if (options.suite !== undefined) {
    const explicit = [...FLAGS].filter((flag) => flag !== '--suite' && options[flag.slice(2)] !== undefined)
    if (explicit.length > 0) throw new InputError(`--suite sets every value itself; drop ${explicit.join(', ')}`)
    const suite = Object.hasOwn(suites, options.suite) && !options.suite.startsWith('_') ? suites[options.suite] : undefined
    if (suite === undefined) throw new InputError(`unknown --suite ${JSON.stringify(options.suite)}`)
    Object.assign(options, { ...suite, floor: String(suite.floor) })
  }
  for (const flag of ['format', 'report', 'baseline', 'floor']) {
    if (options[flag] === undefined) throw new InputError(`--${flag} is required (or --suite)`)
  }
  const floor = Number(options.floor)
  if (!(floor > 0 && floor <= 100)) throw new InputError(`--floor must be a percentage in (0, 100], got ${options.floor}`)
  return { ...options, floor, base: options.base ?? '.' }
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new InputError(`cannot read the ${what} ${path}: ${error.message}`)
  }
}

function printFindings(title, findings, log) {
  if (findings.length === 0) return
  log(`${title} (${findings.length}):`)
  for (const finding of findings) log(`  ${finding}`)
}

/** Runs one check; returns the exit code (0 clean, 1 findings, 2 cannot run). */
export function main(argv, { repoRoot = ROOT, log = console.log, error = console.error } = {}) {
  try {
    const suites = argv.includes('--suite') ? JSON.parse(readText(SUITES_FILE, 'suite configuration')) : {}
    const options = parseArgs(argv, suites)
    const label = options.suite ?? options.baseline
    const files = parseReport(options.format, readText(resolve(repoRoot, options.report), 'report'), { repoRoot, base: options.base })
    const baselinePath = resolve(repoRoot, options.baseline)
    const refresh = options.suite === undefined
      ? 'node scripts/coverage/check-per-file-coverage.mjs ... --update-baseline'
      : `node scripts/coverage/check-per-file-coverage.mjs --suite ${options.suite} --update-baseline`
    if (options.init) {
      if (existsSync(baselinePath)) throw new InputError(`--init refuses: ${options.baseline} exists (the baseline only shrinks)`)
      const text = initBaseline(files, options.floor, refresh)
      writeFileSync(baselinePath, text)
      log(`coverage ${label}: wrote ${options.baseline} with ${parseBaseline(text).length} file(s) under the ${options.floor}% floor`)
      return 0
    }
    const text = readText(baselinePath, 'baseline')
    let rows = parseBaseline(text)
    let result = evaluate(files, rows, options.floor)
    if (options['update-baseline']) {
      if (result.stalePaths.size > 0) writeFileSync(baselinePath, shrinkBaseline(text, result.stalePaths))
      log(`coverage ${label}: removed ${result.stalePaths.size} stale row(s) from ${options.baseline}`)
      rows = rows.filter((row) => !result.stalePaths.has(row.path))
      result = evaluate(files, rows, options.floor)
    }
    printFindings(`files below the ${options.floor}% floor and not in ${options.baseline} (add tests)`, result.belowFloor, log)
    printFindings(`baselined files below their recorded rate (restore their tests)`, result.regressed, log)
    printFindings(`stale rows in ${options.baseline} (run: ${refresh})`, result.stale, log)
    const failed = result.belowFloor.length + result.regressed.length + result.stale.length
    const measured = [...files.values()].filter(({ total }) => total > 0).length
    log(`coverage ${label}: ${measured} file(s) measured, floor ${options.floor}%, ${rows.length} baselined, ${failed === 0 ? 'OK' : `${failed} finding(s)`}`)
    return failed === 0 ? 0 : 1
  } catch (caught) {
    if (!(caught instanceof InputError)) throw caught
    error(`check-per-file-coverage: ${caught.message}`)
    return 2
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
