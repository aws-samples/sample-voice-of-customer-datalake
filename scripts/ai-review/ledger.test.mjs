import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceLedger, decodeLedger, emptyLedger, encodeLedger, parseStatuses, passVerdict, previousFindingsBlock, stripStatusLines } from './ledger.mjs'
import { parseVerdict } from './lib.mjs'

const SHA = 'c'.repeat(40)
const MUST = (title, line = 1) => `MUST-FIX -- a.mjs:${line} -- ${title}\n> x\nTrigger: t\nOutcome: o\nFix: f`
const pass = (kind, output) => ({ kind, output, verdict: parseVerdict(output, kind) })
const bodyWith = (ledger) => `<!-- voc-ai-review sha=${SHA} diffhash=0123456789abcdef -->\n${encodeLedger(ledger)}\n### rest`
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')

test('a ledger survives the round trip through a comment', () => {
  const { ledger } = advanceLedger(null, { sha: SHA }, [pass('commit', `${MUST('cap')}\nREVIEW-VERDICT: commit BLOCK`)])
  assert.deepEqual(decodeLedger(bodyWith(ledger)), { ...ledger, dropped: 0 })
  assert.equal(ledger.round, 1)
  assert.deepEqual(ledger.rounds, [{ round: 1, sha: SHA }])
})

test('a ledger is read only from the line under the marker, and anything malformed is rejected', () => {
  const good = advanceLedger(null, { sha: SHA }, [pass('commit', `${MUST('cap')}\nREVIEW-VERDICT: commit BLOCK`)]).ledger
  assert.equal(decodeLedger(`marker\ntext\n${encodeLedger(good)}`), null, 'not on line 2')
  assert.equal(decodeLedger('marker\n<!-- voc-ai-review-ledger !!! -->'), null)
  assert.equal(decodeLedger(`marker\n<!-- voc-ai-review-ledger ${b64('not json')} -->`), null)
  assert.equal(decodeLedger(`marker\n<!-- voc-ai-review-ledger ${b64({ v: 2, round: 1 })} -->`), null)
  assert.equal(decodeLedger(''), null)
})

test('a malformed finding is dropped alone, and ids are never reused even when `next` is tampered with', () => {
  const raw = {
    v: 1, round: 2, next: { T: 1, C: 1 }, rounds: [],
    findings: [
      { id: 'C7', pass: 'commit', kind: 'MUST-FIX', where: 'a:1', title: 'kept', round: 1, status: 'open', blocking: true },
      { id: 'C8', pass: 'tenets', kind: 'X', round: 1 },
      { id: 'X1', pass: 'commit', round: 1 },
      'junk',
      { id: 'T2', pass: 'tenets', kind: 'CONCERN', where: 'b:2', title: 'closed', round: 1, status: 'resolved' },
    ],
  }
  const ledger = decodeLedger(`marker\n<!-- voc-ai-review-ledger ${b64(raw)} -->`)
  assert.deepEqual(ledger.findings.map((f) => f.id), ['C7'], 'mismatched pass, bad id, junk and closed findings dropped')
  assert.deepEqual(ledger.next, { T: 3, C: 8 })
})

test('STATUS answers count only for ids open in that pass', () => {
  const output = [
    'STATUS -- C1 -- RESOLVED -- fixed in abc',
    'STATUS -- C2 -- answered -- lower case is not the contract',
    'STATUS -- T1 -- RESOLVED -- other pass',
    'STATUS -- C9 -- RESOLVED -- not open',
    '  STATUS -- C3 -- OPEN',
    '> STATUS -- C4 -- RESOLVED -- quoted from the diff',
  ].join('\n')
  const statuses = parseStatuses(output, 'commit', ['C1', 'C2', 'C3', 'C4', 'T1'])
  assert.deepEqual([...statuses], [['C1', { status: 'resolved', note: 'fixed in abc' }], ['C3', { status: 'open', note: '' }]])
  assert.equal(stripStatusLines(`${output}\nREVIEW-VERDICT: commit PASS`), 'STATUS -- C2 -- answered -- lower case is not the contract\n> STATUS -- C4 -- RESOLVED -- quoted from the diff\nREVIEW-VERDICT: commit PASS')
})

test('STATUS lines the model fenced leave no empty code block behind', () => {
  const output = 'Summary.\n\n```\nSTATUS -- C1 -- OPEN -- x\nSTATUS -- C2 -- RESOLVED -- y\n```\n\n```\nNIT -- a:1 -- n\n```\nREVIEW-VERDICT: commit WARN'
  assert.equal(stripStatusLines(output), 'Summary.\n\n```\nNIT -- a:1 -- n\n```\nREVIEW-VERDICT: commit WARN')
})

test('the follow-up block lists the open findings of one pass, with their tenet and round', () => {
  const { ledger } = advanceLedger(null, { sha: SHA }, [
    pass('tenets', 'VIOLATION -- x.ts:2 -- tenet 7: NAT on by default\nTrigger: t\nOutcome: o\nREVIEW-VERDICT: tenets BLOCK'),
    pass('commit', `${MUST('cap')}\nREVIEW-VERDICT: commit BLOCK`),
  ])
  assert.equal(previousFindingsBlock(ledger, 'tenets'), 'T1 [VIOLATION tenet 7] x.ts:2 — NAT on by default (raised in round 1)')
  assert.equal(previousFindingsBlock(ledger, 'commit'), 'C1 [MUST-FIX] a.mjs:1 — cap (raised in round 1)')
  assert.equal(previousFindingsBlock(emptyLedger(), 'commit'), '')
})

test('the verdict follows what is open now: a resolved blocker clears it, an open one blocks over a PASS line', () => {
  const first = advanceLedger(null, { sha: SHA }, [pass('commit', `${MUST('cap')}\nSHOULD-FIX -- b:1 -- s\nWhy: w\nREVIEW-VERDICT: commit BLOCK`)])
  assert.equal(passVerdict(first.recap.commit, 'BLOCK'), 'BLOCK')
  const fixed = advanceLedger(first.ledger, { sha: SHA }, [pass('commit', 'STATUS -- C1 -- RESOLVED -- r\nSTATUS -- C2 -- ANSWERED -- a\nREVIEW-VERDICT: commit PASS')])
  assert.equal(passVerdict(fixed.recap.commit, 'PASS'), 'PASS')
  assert.deepEqual(fixed.ledger.findings, [])
  const ignored = advanceLedger(first.ledger, { sha: SHA }, [pass('commit', 'REVIEW-VERDICT: commit PASS')])
  assert.equal(passVerdict(ignored.recap.commit, 'PASS'), 'BLOCK')
  const onlyWarn = advanceLedger(first.ledger, { sha: SHA }, [pass('commit', 'STATUS -- C1 -- RESOLVED -- r\nREVIEW-VERDICT: commit PASS')])
  assert.equal(passVerdict(onlyWarn.recap.commit, 'PASS'), 'WARN', 'C2 (SHOULD-FIX) still open')
  assert.equal(passVerdict(advanceLedger(null, { sha: SHA }, [pass('commit', 'no verdict')]).recap.commit, 'INCOMPLETE'), 'INCOMPLETE')
  assert.equal(passVerdict({ error: true }, 'PASS'), null)
})

test('past 100 open findings the oldest are dropped and counted', () => {
  const many = Array.from({ length: 105 }, (_, i) => `NIT -- f.ts:${i + 1} -- n${i + 1}`).join('\n')
  const { ledger } = advanceLedger(null, { sha: SHA }, [pass('commit', `${many}\nREVIEW-VERDICT: commit WARN`)])
  assert.equal(ledger.findings.length, 100)
  assert.equal(ledger.dropped, 5)
  assert.equal(ledger.findings[0].id, 'C6')
  assert.equal(ledger.next.C, 106)
})

test('a finding\'s text from the model is bounded and kept on one line', () => {
  const { ledger } = advanceLedger(null, { sha: SHA }, [pass('commit', `NIT -- f.ts:1 -- ${'x'.repeat(500)}\nREVIEW-VERDICT: commit WARN`)])
  assert.equal(ledger.findings[0].title.length, 200)
  assert.ok(ledger.findings[0].title.endsWith('…'), 'a cut title says so')
  assert.doesNotMatch(encodeLedger(ledger), /\n/)
})
