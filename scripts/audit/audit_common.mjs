// The one library of the Node audit detectors in scripts/audit/ (not a detector: it carries no marker).
//
// Its Python twin is audit_common.py; both keep the same rules, so the detectors of both languages read and
// report alike:
// - paths are repo-relative POSIX strings; path globs use `**` (any directories) and `*` / `?` (one segment),
//   finding-key globs use `*` for any run of characters;
// - `isTestPath`: tests, specs, test support, fixtures and dev mocks (also the TS programs' production rule);
// - allowlists: `allowlists/<tool>.json` = {"entries": [...]}, read by ONE loader (`readAllowlist`): every entry
//   needs a non-empty `reason` (else exit 2) plus its tool's shape (`key` for ts_*, `files` for clones);
//   `splitAllowlisted` applies any shape and returns the stale entries, which a full run reports as findings;
// - the CLI contract (`detectorMain`, `printReport`): `--help` exits 0, `--json` alone prints the JSON report
//   INSTEAD of the text one, `--json PATH` writes it there AS WELL, the first text line is
//   `<tool>: N finding(s); <summary>`, exit 0 clean / 1 findings / 2 the scan cannot be trusted (`AuditError`).
// It also builds the repo's three TypeScript programs for the ts_* detectors (`realPrograms`, `createService`)
// with the repo's own `typescript` (voc-datalake/frontend/node_modules), so types resolve as `tsc` does in CI.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const ALLOWLIST_DIR = join(HERE, 'allowlists')
export const EXIT = Object.freeze({ clean: 0, findings: 1, error: 2 })

/** A detector cannot run or its result cannot be trusted: exit 2. */
export class AuditError extends Error {}

// ── paths and globs ───────────────────────────────────────────────────

/** Never scanned: dependencies, build output, vendored layers, caches (audit_common.py SKIP_DIRS). */
const SKIP_DIRS = new Set([
  'node_modules', '.venv', 'cdk.out', 'dist', 'build', 'coverage', '__pycache__', '.git', '.cache',
  '.stryker-tmp', '.mutmut-cache', 'layers', 'coverage_html',
])
/** Tests, specs, test support, fixtures and dev mocks (audit_common.py `_TEST_PATH`). */
const TEST_PATH = /(^|\/)(test|tests|__tests__|__fixtures__|test-support|e2e)\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$|-fixtures\.[jt]sx?$|(^|\/)mock[^/]*\.[cm]?js$/

export const isTestPath = (rel) => TEST_PATH.test(rel)

/** POSIX path relative to `base`. */
export const posixRel = (base, file) => relative(base, file).split(sep).join('/')

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const globCache = new Map()
/** Path glob: `**` = any directories (also none), `*` / `?` = within one segment. */
export function globRegex(glob) {
  if (!globCache.has(glob)) {
    let out = ''
    for (let i = 0; i < glob.length;) {
      if (glob.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3 }
      else if (glob.startsWith('**', i)) { out += '.*'; i += 2 }
      else { out += { '*': '[^/]*', '?': '[^/]' }[glob[i]] ?? escapeRe(glob[i]); i += 1 }
    }
    globCache.set(glob, new RegExp(`^${out}$`))
  }
  return globCache.get(glob)
}

export const matchesAny = (rel, globs) => globs.some((g) => globRegex(g).test(rel))

/** Finding-key glob: `*` = any run of characters, `?` = one character. */
export const keyRegex = (pattern) => new RegExp(`^${[...pattern].map((c) => ({ '*': '.*', '?': '.' })[c] ?? escapeRe(c)).join('')}$`)

/** Absolute paths of the files under `dir` (recursive, sorted) whose name passes `keep`; SKIP_DIRS are skipped. */
export function walkFiles(dir, keep = () => true) {
  const out = []
  if (!existsSync(dir)) return out
  if (!statSync(dir).isDirectory()) return keep(dir.split(sep).at(-1), dir) ? [dir] : []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) out.push(...walkFiles(full, keep)) }
    else if (keep(name, full)) out.push(full)
  }
  return out
}

/** [{rel, file}] of every source file under `scanPaths` (relative to `root`), sorted, tests skipped unless asked. */
export function listFiles(root, scanPaths, { suffixes, includeTests = false, exclude = [] }) {
  return scanPaths.flatMap((scan) => walkFiles(join(root, scan), (name) => suffixes.some((s) => name.endsWith(s)) && !name.endsWith('.d.ts'))
    .map((file) => ({ rel: posixRel(root, file), file }))
    .filter(({ rel }) => (includeTests || !isTestPath(rel)) && !matchesAny(rel, exclude)))
}

let tsModule
/** The repo's own `typescript` (resolved from the SPA package, which pins it). */
export function loadTypeScript(root = REPO_ROOT) {
  if (tsModule) return tsModule
  const anchor = [join(root, 'voc-datalake/frontend/package.json'), join(REPO_ROOT, 'voc-datalake/frontend/package.json')]
    .find((file) => existsSync(file))
  if (!anchor) throw new AuditError('cannot find voc-datalake/frontend/package.json to resolve typescript from')
  tsModule = createRequire(anchor)('typescript')
  return tsModule
}

// ── programs ──────────────────────────────────────────────────────────

/**
 * The repo's three programs. `entries` are files whose module code runs (`module`) and/or whose exports
 * are called from outside the program (`exports`: a Lambda handler, a generator a script prints).
 * `min` is the vacuity guard: fewer files/declarations than this means the scan saw the wrong tree.
 */
export function realPrograms(root = REPO_ROOT) {
  const cdk = join(root, 'voc-datalake')
  const fe = join(cdk, 'frontend')
  const stream = join(cdk, 'lambda/stream')
  return [
    {
      name: 'frontend',
      base: fe,
      tsconfigs: [join(fe, 'tsconfig.test.json')],
      entries: [{ file: 'src/main.tsx', module: true }],
      isTestFile: isTestPath,
      min: { files: 600, declarations: 8000 },
    },
    {
      name: 'stream',
      base: stream,
      tsconfigs: [join(stream, 'tsconfig.json')],
      entries: [
        { file: 'src/handler.ts', module: true, exports: true },
        { file: 'src/plan-step/handler.ts', module: true, exports: true },
        // Printed by scripts/write-plan-contract.mjs into lambda/shared/plan_contract.json.
        { file: 'src/assistant/plan/contract-json.ts', module: true, exports: true },
      ],
      isTestFile: isTestPath,
      min: { files: 100, declarations: 1500 },
    },
    {
      name: 'cdk',
      base: cdk,
      // tsconfig.tools.json adds the ts-node scripts (and the gate rules, which are not this program's).
      tsconfigs: [join(cdk, 'tsconfig.json'), join(cdk, 'tsconfig.tools.json')],
      fileFilter: (rel) => /^(bin|lib|scripts)\//.test(rel) && /\.ts$/.test(rel),
      entries: [{ file: 'bin/voc-datalake.ts', module: true }, { glob: /^scripts\/(capacity\/)?[^/]+\.ts$/, module: true }],
      isTestFile: (rel) => isTestPath(rel) || rel === 'vitest.config.ts',
      min: { files: 80, declarations: 1000 },
    },
  ]
}

/** `{root, defs}` for a CLI's `--root`/`--program` flags (unknown program = AuditError). */
export function selectPrograms(args) {
  const root = args.root ? resolve(args.root) : REPO_ROOT
  const defs = realPrograms(root).filter((d) => !args.program || d.name === args.program)
  if (!defs.length) throw new AuditError(`unknown program ${args.program}`)
  return { root, defs }
}

/** Parse every tsconfig of a definition into one file list + the first config's options. */
export function programFiles(ts, def) {
  let options
  const files = new Set()
  for (const configPath of def.tsconfigs) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (read.error) throw new AuditError(`${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath)
    options ??= parsed.options
    for (const file of parsed.fileNames) {
      const rel = posixRel(def.base, file)
      if (!def.fileFilter || def.fileFilter(rel)) files.add(resolve(file))
    }
  }
  return { options: { ...options, noEmit: true, incremental: false, composite: false }, files: [...files] }
}

/** A LanguageService over one program definition; `.program`/`.checker` are its program. */
export function createService(ts, def) {
  const { options, files } = programFiles(ts, def)
  const versions = new Map(files.map((f) => [f, '1']))
  const host = {
    getScriptFileNames: () => files,
    getScriptVersion: (f) => versions.get(f) ?? '1',
    getScriptSnapshot: (f) => (ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f) ?? '') : undefined),
    getCurrentDirectory: () => def.base,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const program = service.getProgram()
  if (!program) throw new AuditError(`${def.name}: no program`)
  return { service, program, checker: program.getTypeChecker(), files }
}

/** Source files of the program that belong to the repo (not node_modules, not lib.d.ts). */
export function ownSourceFiles(program, def) {
  return program.getSourceFiles().filter((sf) => {
    const file = resolve(sf.fileName)
    if (file.includes(`${sep}node_modules${sep}`) || program.isSourceFileDefaultLibrary(sf)) return false
    const rel = posixRel(def.base, file)
    return !rel.startsWith('..') && (!def.fileFilter || def.fileFilter(rel))
  })
}

/** `node` without the parentheses, `as` and `satisfies` around it (`(x as const)` → `x`). */
export function unwrapExpression(ts, node) {
  let out = node
  while (out && (ts.isParenthesizedExpression(out) || ts.isAsExpression(out) || ts.isSatisfiesExpression(out))) out = out.expression
  return out
}

/** Is `rel` (relative to def.base) an entry for module code / exports? */
export function entryFor(def, rel) {
  return def.entries.find((e) => (e.file ? e.file === rel : e.glob.test(rel)))
}

/** Vacuity guard: throws (exit 2) when a real-tree scan saw fewer files/symbols than plausible. */
export function checkVacuity(def, counts) {
  if (!def.min) return
  for (const [what, min] of Object.entries(def.min)) {
    if ((counts[what] ?? 0) < min) {
      throw new AuditError(`${def.name}: vacuous scan, saw ${counts[what] ?? 0} ${what} (expected at least ${min}); wrong tree or broken tsconfig?`)
    }
  }
}

// ── allowlists ────────────────────────────────────────────────────────

/** The entries of an allowlist file (missing = none); each needs a non-empty `reason` and the `required` keys. */
export function readAllowlist(file, required) {
  if (!existsSync(file)) return []
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new AuditError(`${file}: unreadable allowlist (${error.message})`)
  }
  if (!Array.isArray(data?.entries)) throw new AuditError(`${file}: expected {"entries": [...]}`)
  data.entries.forEach((entry, i) => {
    if (typeof entry?.reason !== 'string' || !entry.reason.trim()) throw new AuditError(`${file}: entry ${i + 1} has no reason`)
    const missing = required.filter((key) => typeof entry[key] !== 'string' && !Array.isArray(entry[key]))
    if (missing.length) throw new AuditError(`${file}: entry ${i + 1} lacks ${missing.join(', ')}`)
  })
  return data.entries
}

/** `{kept, excused, stale}`: items no entry excuses, excused items, and the entries that excuse nothing. */
export function splitAllowlisted(items, entries, matches) {
  const used = new Set()
  const kept = []
  const excused = []
  for (const item of items) {
    const hits = entries.filter((entry) => matches(entry, item))
    hits.forEach((entry) => used.add(entry))
    ;(hits.length ? excused : kept).push(item)
  }
  return { kept, excused, stale: entries.filter((entry) => !used.has(entry)) }
}

/** The key-shaped allowlist of a ts_* detector: `[{key, reason, kind?, re}]` (`key: 'kind:<kind>'` = a whole kind). */
export function loadAllowlist(tool, dir = ALLOWLIST_DIR) {
  return readAllowlist(join(dir, `${tool}.json`), ['key']).map((entry) => ({ ...entry, re: keyRegex(entry.key) }))
}

const keyEntryMatches = (entry, finding) => (entry.kind === undefined || entry.kind === finding.kind)
  && (entry.key === `kind:${finding.kind}` || entry.re.test(finding.key))

export const staleFinding = (key) => ({ key, kind: 'stale-allowlist', detail: 'allowlist entry matches no finding; delete it' })

/** `{left, excused}`: findings no entry excuses (+ a `stale-allowlist` finding per unused entry when `reportStale`). */
export function applyAllowlist(findings, entries, { reportStale = true } = {}) {
  const { kept, excused, stale } = splitAllowlisted(findings, entries, keyEntryMatches)
  return { left: reportStale ? [...kept, ...stale.map((e) => staleFinding(e.key))] : kept, excused: excused.length }
}

// ── CLI and report ────────────────────────────────────────────────────

const JSON_HELP = '  --json [PATH]   JSON report to stdout instead of the text report; with PATH, also write it there'

/**
 * `--name value` / `--name=value` / `--flag`; everything else is positional. `spec` maps a flag to 'boolean',
 * 'string', 'number' or 'list' (repeatable). `--json [PATH]` and `--help` are always accepted: `json` is `true`
 * (stdout) or the path.
 */
export function parseArgs(argv, spec = {}) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') { opts.help = true; continue }
    if (!arg.startsWith('--')) { opts._.push(arg); continue }
    const [name, inline] = arg.slice(2).split(/=(.*)/s)
    if (name === 'json') {
      const next = argv[i + 1]
      opts.json = inline ?? (next !== undefined && !next.startsWith('--') ? argv[i += 1] : true)
      continue
    }
    if (!(name in spec)) throw new AuditError(`unknown option ${arg}`)
    if (spec[name] === 'boolean') { opts[name] = true; continue }
    const value = inline ?? argv[i += 1]
    if (value === undefined) throw new AuditError(`${arg} needs a value`)
    if (spec[name] === 'list') opts[name] = [...(opts[name] ?? []), value]
    else opts[name] = spec[name] === 'number' ? Number(value) : value
  }
  return opts
}

export function writeJson(target, payload) {
  if (!target) return
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`)
}

/** Default text lines: findings grouped by kind, sorted by key. */
function kindLines(tool, findings) {
  const byKind = new Map()
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  return [...byKind].flatMap(([kind, list]) => [`${tool}: ${kind} (${list.length})`,
    ...[...list].sort((a, b) => a.key.localeCompare(b.key)).map((f) => `  ${f.key}${f.detail ? `  — ${f.detail}` : ''}`)])
}

/**
 * The report contract; returns 0 (clean) or 1 (findings). `json`: true = the JSON report to stdout INSTEAD of the
 * text, a path = written there AS WELL. `lines` replaces the default per-kind listing; `extra` joins the JSON.
 */
export function printReport(tool, findings, { json, summary = '', lines, extra = {} } = {}) {
  const headline = `${tool}: ${findings.length} finding(s)${summary ? `; ${summary}` : ''}`
  const payload = { tool, summary: headline, findings, ...extra }
  if (json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    writeJson(json, payload)
    console.log([headline, ...(lines ?? kindLines(tool, findings))].join('\n'))
  }
  return findings.length ? EXIT.findings : EXIT.clean
}

/** A ts_* detector's last step: its key-shaped allowlist (unless --no-allowlist), then the report. */
export function finishReport(tool, args, findings, { summary, reportStale = true }) {
  const entries = args['no-allowlist'] ? [] : loadAllowlist(tool)
  const { left, excused } = applyAllowlist(findings, entries, { reportStale })
  return printReport(tool, left, { json: args.json, summary: `${summary}; ${excused} allowlisted` })
}

const failed = (tool, error) => {
  if (!(error instanceof AuditError)) console.error(error)
  console.error(`${tool}: ${error.message}`)
  return EXIT.error
}

/**
 * `main(argv) -> exit code` (or a promise of one) of a detector: parse `spec` (plus --json / --help), print
 * `usage` for --help, run `body(args)`; an error is exit 2 with its message.
 */
export function detectorMain(tool, { usage, spec = {} }, body) {
  return (argv) => {
    try {
      const args = parseArgs(argv, spec)
      if (args.help) {
        const flags = Object.entries(spec).map(([name, type]) => `[--${name}${type === 'boolean' ? '' : ` <${type}>`}]`)
        console.log([`usage: ${tool} ${[...flags, '[--json [PATH]]', '[--help]'].join(' ')}`, usage, JSON_HELP,
          'Exit: 0 clean, 1 findings, 2 error (bad allowlist, vacuous scan).'].join('\n'))
        return EXIT.clean
      }
      const out = body(args)
      return out instanceof Promise ? out.catch((error) => failed(tool, error)) : out
    } catch (error) {
      return failed(tool, error)
    }
  }
}

/**
 * `main` of a detector that scans one tree: `--root`, `--no-allowlist` and `--<minFlag>` (default `min`), the
 * vacuity guard on `scan(root).count`, then `finishReport` (stale entries are judged on the real tree only).
 * `scan(root)` returns `{findings, count, summary}`; `what` names what `count` counts in the exit-2 message.
 */
export function scanDetectorMain(tool, { usage, minFlag, min, what }, scan) {
  return detectorMain(tool, { usage, spec: { root: 'string', 'no-allowlist': 'boolean', [minFlag]: 'number' } }, (args) => {
    const root = args.root ? resolve(args.root) : REPO_ROOT
    const { findings, count, summary } = scan(root)
    const floor = args[minFlag] ?? min
    if (count < floor) throw new AuditError(`vacuous scan: ${count} ${what} (expected at least ${floor})`)
    return finishReport(tool, args, findings, { summary, reportStale: !args.root })
  })
}

/** Run `main` as the process when its module is the entry script (`import.meta.url`). */
export async function runIfMain(metaUrl, main) {
  if (process.argv[1] && fileURLToPath(metaUrl) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2))
}
