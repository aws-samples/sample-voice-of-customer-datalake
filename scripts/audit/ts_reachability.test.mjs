import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { analyzeProgram } from './ts_reachability.mjs'
import { fixtureProject, kinds } from './ts_audit_fixture.mjs'

const LIB = `
export const api = {
  used: () => 1,
  onlyTests: () => 2,
  nobody: () => 3,
}
export function deadFn() { return 1 }
export interface Unused { a: string }

interface ThingResult { shown: number; hidden: number }
export function useThing(): ThingResult { return { shown: 1, hidden: 2 } }

interface Props { title: string }
export function render({ title }: Props) { return title }

const MESSAGES: Record<number, { messageKey: string }> = { 404: { messageKey: 'nf' } }
const GENERIC = { messageKey: 'generic' }
export function messageFor(status: number) { return (MESSAGES[status] ?? GENERIC).messageKey }

interface Payload { id: string; extra: number }
export function sendIt() { const p: Payload = { id: 'a', extra: 1 }; return JSON.stringify(p) }

interface Runner { run(): void }
export class Impl implements Runner { run() {} unusedMethod() {} }
export function runIt() { const r: Runner = new Impl(); r.run() }

const SHAPE = { total: 1, other: 2 }
function object<T extends Record<string, unknown>>(s: T) { return Object.keys(s).length }
export function viaShape() { return object({ ...SHAPE }) }

interface Holder { lastIndex: number }
export function holder() { const h: Holder = /x/g; h.lastIndex = 0 }

interface Style { color?: string }
type Vars = { '--x': string; color?: string }
export function styleFor(): Style { const v: Vars = { '--x': '1px' }; return v as Style }

export function lazyLoad() { return import('./page') }
`

const MAIN = `
import { api, useThing, render, messageFor, sendIt, runIt, viaShape, holder, styleFor, lazyLoad } from './lib'
api.used()
const { shown } = useThing()
console.log(shown, render({ title: 'x' }), messageFor(404), sendIt(), viaShape(), styleFor())
runIt()
holder()
void lazyLoad()
`

const PAGE = `
export default function Page() { return 1 }
export function alsoExported() { return 2 }
`

function run(files, options) {
  const fx = fixtureProject(files, options)
  try {
    return analyzeProgram(fx.def, options?.analyze ?? {})
  } finally {
    fx.cleanup()
  }
}

test('reports the planted dead, test-only and write-only declarations, and nothing else', () => {
  const { findings, counts } = run({
    'src/lib.ts': LIB, 'src/main.ts': MAIN, 'src/page.ts': PAGE,
    'src/lib.test.ts': "import { api } from './lib'\napi.onlyTests()\n",
  })
  assert.deepEqual(kinds(findings), {
    'fx:src/lib.ts#api.onlyTests': 'test-only',
    'fx:src/lib.ts#api.nobody': 'dead',
    'fx:src/lib.ts#deadFn': 'dead',
    'fx:src/lib.ts#Unused': 'dead-type',
    'fx:src/lib.ts#ThingResult.hidden': 'write-only',
    'fx:src/lib.ts#Impl.unusedMethod': 'dead',
  })
  assert.ok(counts.declarations > 20, 'the fixture was scanned')
})

test('a dead parent folds its members (one finding for a dead table)', () => {
  const { findings } = run({
    'src/main.ts': 'export {}\n',
    'src/lib.ts': 'export const table = { a: () => 1, b: { c: 2 } }\nexport interface Shape { x: number; y: number }\n',
  })
  assert.deepEqual(kinds(findings), { 'fx:src/lib.ts#table': 'dead', 'fx:src/lib.ts#Shape': 'dead-type' })
})

test('what an entry handler returns is read by the platform (exports entries only)', () => {
  const handler = 'interface Result { statusCode: number; body: string }\nexport async function handler(): Promise<Result> { return { statusCode: 200, body: "" } }\n'
  const asEntry = run({ 'src/handler.ts': handler }, { entries: [{ file: 'src/handler.ts', module: true, exports: true }] })
  assert.deepEqual(asEntry.findings, [])
  const notEntry = run({ 'src/handler.ts': handler, 'src/main.ts': "import { handler } from './handler'\nvoid handler()\n" })
  assert.deepEqual(kinds(notEntry.findings), {
    'fx:src/handler.ts#Result.statusCode': 'write-only',
    'fx:src/handler.ts#Result.body': 'write-only',
  })
})

test('type members neither read nor written are listed only with allMembers', () => {
  const files = {
    'src/main.ts': "import type { Wire } from './wire'\nexport const parse = (raw: unknown) => raw as Wire\nconsole.log(parse(1).used)\n",
    'src/wire.ts': 'export interface Wire { used: string; neverRead: string }\n',
  }
  assert.deepEqual(run(files).findings, [])
  assert.deepEqual(kinds(run(files, { analyze: { allMembers: true } }).findings), { 'fx:src/wire.ts#Wire.neverRead': 'unread-type-member' })
})

test('evidence re-checks a finding with LanguageService.findReferences', () => {
  const { findings } = run({
    'src/main.ts': "import { api } from './lib'\napi.used()\n",
    'src/lib.ts': 'export const api = { used: () => 1, onlyTests: () => 2 }\n',
    'src/lib.test.ts': "import { api } from './lib'\napi.onlyTests()\napi.onlyTests()\n",
  }, { analyze: { evidence: true } })
  assert.equal(findings.length, 1)
  assert.match(findings[0].detail, /findReferences prod 0, test 2/)
})


test('never-written: an optional option member that is read but that nothing sets', () => {
  const lib = [
    'export interface CollectOptions { start: number; maxPolls?: number; sleep?: (ms: number) => void; label?: string; via?: number }',
    'interface Local { only?: number }',
    'export interface Shaped { via?: number }',
    'export function collect(o: CollectOptions, l: Local) { o.sleep?.(1); return [o.start, o.maxPolls ?? 90, o.label, o.via, l.only] }',
    'export function fromShaped(s: Shaped) { return collect({ start: 1, ...s }, {}) }',
  ].join('\n')
  const tsconfig = { compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', skipLibCheck: true, noEmit: true, types: [] }, include: ['src', 'lib'] }
  const { findings } = run({
    'tsconfig.json': JSON.stringify(tsconfig),
    'lib/capacity.ts': lib,
    'lib/capacity.test.ts': "import { collect } from './capacity'\ncollect({ start: 1, label: 'x' }, {})\n",
    'src/main.ts': "import { collect, fromShaped } from '../lib/capacity'\ncollect({ start: 2, sleep: () => {} }, {})\nfromShaped({ via: 1 })\n",
  })
  // `sleep` set in production, `label` by a test, `via` through a spread of another shape, `only` is not an
  // exported option shape, `start` is required: only `maxPolls` is a dead knob.
  assert.deepEqual(Object.entries(kinds(findings)).filter(([, kind]) => kind === 'never-written'), [['fx:lib/capacity.ts#CollectOptions.maxPolls', 'never-written']])
})
