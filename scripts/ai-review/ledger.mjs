/**
 * The findings ledger of the pull request AI review: what each review round found, and what became of it.
 *
 * Every finding gets a stable id (`T1`, `T2`… for the tenets review, `C1`… for the code review). From the second round
 * on, the model gets the findings still open and answers one STATUS line per id; this module turns those answers and
 * the round's new findings into the next ledger and the recap the comment shows: Resolved, Still open, Answered by the
 * author, New. The ledger travels in the comment itself, base64 JSON in a hidden line under the marker, and only a
 * comment by the workflow's own bot is read back (ci-lib.mjs → latestReview). Only OPEN findings travel on: a
 * resolved or answered one is shown in the recap of the round that closed it, then leaves the ledger, which keeps the
 * comment small however long the pull request runs.
 *
 * There is deliberately no cap on rounds (owner's decision): review converges because later rounds review only the
 * new commits and never re-raise a finding that is still open, they list it by id.
 */

/** The id prefix of each pass. */
export const PREFIX = Object.freeze({ tenets: 'T', commit: 'C' })
const PASS_OF = Object.freeze({ T: 'tenets', C: 'commit' })
const STATUSES = Object.freeze(['open', 'resolved', 'answered'])
const LEDGER_LINE = /^<!-- voc-ai-review-ledger ([A-Za-z0-9+/=]+) -->$/
// A bound on what a comment carries into the next prompt. Past it the OLDEST open findings are dropped, and the recap
// says how many.
const MAX_OPEN = 100
const MAX_TEXT = 200

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value, max = MAX_TEXT) => {
  const line = typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim() : ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const count = (value) => (Number.isInteger(value) && value >= 0 && value < 100_000 ? value : null)

/** An empty ledger, before the first round. */
export function emptyLedger() {
  return { v: 1, round: 0, next: { T: 1, C: 1 }, findings: [], rounds: [], dropped: 0 }
}

/** The hidden line that carries `ledger` in a comment. */
export function encodeLedger(ledger) {
  return `<!-- voc-ai-review-ledger ${Buffer.from(JSON.stringify(ledger), 'utf8').toString('base64')} -->`
}

/** One finding read back from a comment, or null when it is not shaped like one. */
function readFinding(value) {
  if (!isRecord(value)) return null
  const id = text(value.id, 8)
  const pass = PASS_OF[id[0]]
  const round = count(value.round)
  if (!/^[TC]\d{1,4}$/.test(id) || pass === undefined || value.pass !== pass || round === null) return null
  const status = STATUSES.includes(value.status) ? value.status : 'open'
  return {
    id, pass, kind: text(value.kind, 20), where: text(value.where), title: text(value.title),
    tenet: typeof value.tenet === 'string' ? text(value.tenet, 4) : null, blocking: value.blocking === true, round, status,
    note: text(value.note), closedRound: count(value.closedRound),
  }
}

/**
 * The ledger in a comment body (the line right under the marker), or null. Anything malformed is dropped, finding by
 * finding, so one bad entry cannot hide the others.
 */
export function decodeLedger(body) {
  const line = String(body).split('\n', 3)[1]?.trim() ?? ''
  const match = LEDGER_LINE.exec(line)
  if (!match) return null
  let raw
  try {
    raw = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== 1 || count(raw.round) === null) return null
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).map(readFinding).filter(Boolean)
  const highest = (prefix) => Math.max(0, ...findings.filter((f) => f.id[0] === prefix).map((f) => Number(f.id.slice(1))))
  const next = isRecord(raw.next) ? raw.next : {}
  const rounds = (Array.isArray(raw.rounds) ? raw.rounds : []).filter(isRecord)
    .map((r) => ({ round: count(r.round), sha: /^[0-9a-f]{7,40}$/.test(r.sha ?? '') ? r.sha : '' }))
    .filter((r) => r.round !== null)
  return {
    v: 1, round: raw.round,
    // Never reuse an id, even if `next` was tampered with or lost.
    next: { T: Math.max(count(next.T) ?? 1, highest('T') + 1), C: Math.max(count(next.C) ?? 1, highest('C') + 1) },
    findings: findings.filter((f) => f.status === 'open').slice(-MAX_OPEN), rounds: rounds.slice(-50), dropped: 0,
  }
}

const STATUS_LINE = /^STATUS -- ([TC]\d{1,4}) -- (RESOLVED|OPEN|ANSWERED)(?: -- (.*))?$/

/** The STATUS answers in a pass's output, for ids that were open in that pass: Map id → {status, note}. */
export function parseStatuses(output, pass, openIds) {
  const wanted = new Set(openIds)
  const statuses = new Map()
  for (const line of String(output).split(/\r?\n/)) {
    const match = STATUS_LINE.exec(line.trim())
    if (!match || !wanted.has(match[1]) || PASS_OF[match[1][0]] !== pass) continue
    statuses.set(match[1], { status: match[2].toLowerCase(), note: text(match[3] ?? '') })
  }
  return statuses
}

/** The output without its STATUS lines (they are shown in the recap instead), nor a code fence they leave empty. */
export function stripStatusLines(output) {
  return String(output).split(/\r?\n/).filter((line) => !STATUS_LINE.test(line.trim())).join('\n')
    .replace(/^(`{3,})[^\n`]*\n(?:[ \t]*\n)*\1[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The prompt block listing the findings of `pass` still open, for the model to answer by id. */
export function previousFindingsBlock(ledger, pass) {
  const open = ledger.findings.filter((f) => f.pass === pass && f.status === 'open')
  return open.map((f) => `${f.id} [${f.kind}${f.tenet ? ` tenet ${f.tenet}` : ''}] ${f.where} — ${f.title} (raised in round ${f.round})`).join('\n')
}

/**
 * The next ledger and the recap of each pass. `results` are the passes of this round
 * (`{kind, output, verdict}`, or `{kind, error: true}` when the call failed: that pass's open findings carry over
 * untouched). An open finding the model gave no STATUS for stays open: nothing quietly disappears.
 */
export function advanceLedger(previous, { sha }, results) {
  const ledger = structuredClone(previous ?? emptyLedger())
  ledger.round += 1
  ledger.rounds = [...ledger.rounds, { round: ledger.round, sha }].slice(-50)
  const recap = {}
  for (const result of results) {
    const pass = result.kind
    const prefix = PREFIX[pass]
    const open = ledger.findings.filter((f) => f.pass === pass && f.status === 'open')
    const entry = { resolved: [], answered: [], stillOpen: [], added: [], error: Boolean(result.error) }
    recap[pass] = entry
    if (result.error) { entry.stillOpen = open; continue }
    const statuses = parseStatuses(result.output, pass, open.map((f) => f.id))
    for (const finding of open) {
      const answer = statuses.get(finding.id)
      if (answer && answer.status !== 'open') {
        finding.status = answer.status
        finding.note = answer.note
        finding.closedRound = ledger.round
        entry[answer.status].push(finding)
      } else {
        finding.note = answer ? answer.note : 'no status given this round'
        entry.stillOpen.push(finding)
      }
    }
    const complete = new Set(result.verdict.blocking)
    for (const item of [...result.verdict.blocking, ...result.verdict.others]) {
      const finding = {
        id: `${prefix}${ledger.next[prefix]++}`, pass, kind: item.kind, where: text(item.where), title: text(item.title),
        tenet: item.tenet ?? null, blocking: complete.has(item), round: ledger.round, status: 'open', note: '', closedRound: null,
      }
      ledger.findings.push(finding)
      entry.added.push(finding)
    }
  }
  const open = ledger.findings.filter((f) => f.status === 'open')
  ledger.dropped = Math.max(0, open.length - MAX_OPEN)
  ledger.findings = open.slice(-MAX_OPEN)
  return { ledger, recap }
}

/**
 * A pass's verdict this round, from what is OPEN now, not only what the model said: a blocking finding still open
 * blocks even when the model's own line says PASS, and a resolved one no longer counts.
 */
export function passVerdict(entry, modelVerdict) {
  if (entry.error) return null
  const live = [...entry.stillOpen, ...entry.added]
  if (live.some((f) => f.blocking)) return 'BLOCK'
  if (modelVerdict === 'INCOMPLETE') return 'INCOMPLETE'
  return live.length > 0 ? 'WARN' : 'PASS'
}
