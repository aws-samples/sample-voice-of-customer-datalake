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
// What one comment carries into the next round, sized so the ledger line stays far below GitHub's 65,536-character
// comment limit (40 findings × ~400 characters of JSON, base64 ≈ 22,000). Past it the OLDEST NON-BLOCKING open
// findings are dropped first, and the comment says how many: a blocker is the last thing to go.
export const MAX_OPEN = 40
const MAX_TEXT = 160

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
// One line, bounded, and no angle brackets: a finding's text goes back into the next prompt inside a tag, and a
// quoted `</previous-findings>` must not be able to close it.
const text = (value, max = MAX_TEXT) => {
  const line = typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').trim() : ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const count = (value) => (Number.isInteger(value) && value >= 0 && value < 100_000 ? value : null)

/** An empty ledger, before the first round. */
export function emptyLedger() {
  return { v: 1, round: 0, next: { T: 1, C: 1 }, findings: [], reviewed: { tenets: '', commit: '' }, dropped: 0 }
}

/**
 * The hidden line that carries `ledger` in a comment: the round, the id counters and the OPEN findings, each with only
 * what the next round needs (a status note belongs to the round that wrote it, and is shown in its recap).
 */
export function encodeLedger(ledger) {
  const findings = ledger.findings.filter((f) => f.status === 'open')
    .map(({ id, pass, kind, where, title, tenet, blocking, round }) => ({ id, pass, kind, where, title, tenet, blocking, round }))
  const carried = { v: 1, round: ledger.round, next: ledger.next, findings, reviewed: ledger.reviewed, dropped: ledger.dropped ?? 0 }
  return `<!-- voc-ai-review-ledger ${Buffer.from(JSON.stringify(carried), 'utf8').toString('base64')} -->`
}

/**
 * `{kept, dropped}`: at most MAX_OPEN findings, in their original order. Blocking findings are kept first (newest
 * first if even they overflow), then the newest of the rest.
 */
function bound(findings) {
  if (findings.length <= MAX_OPEN) return { kept: findings, dropped: 0 }
  const newestFirst = [...findings].reverse()
  const keep = new Set([...newestFirst.filter((f) => f.blocking), ...newestFirst.filter((f) => !f.blocking)].slice(0, MAX_OPEN))
  return { kept: findings.filter((f) => keep.has(f)), dropped: findings.length - keep.size }
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
    note: '', closedRound: null,
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
  const { kept, dropped } = bound(findings.filter((f) => f.status === 'open'))
  // The commit each pass last reviewed to the end ('' = none yet); absent in a ledger written before it was recorded.
  const sha = (value) => (typeof value === 'string' && /^([0-9a-f]{40})?$/.test(value) ? value : '')
  const reviewed = isRecord(raw.reviewed) ? { tenets: sha(raw.reviewed.tenets), commit: sha(raw.reviewed.commit) } : undefined
  return {
    v: 1, round: raw.round, ...(reviewed ? { reviewed } : {}),
    // Never reuse an id, even if `next` was tampered with or lost.
    next: { T: Math.max(count(next.T) ?? 1, highest('T') + 1), C: Math.max(count(next.C) ?? 1, highest('C') + 1) },
    // Dropped so far: the comment reports the total over the pull request, not one round.
    findings: kept, dropped: (count(raw.dropped) ?? 0) + dropped,
  }
}

// A short SHA (7 to 40 hex characters with at least one digit, so not a word like "defaced"; an all-digit SHA is
// valid) and a `path:line`. The shape is checked, not the commit: a date like 20261108 passes. The citation stays
// self-asserted by the model until a verifier checks it (a planned follow-up).
const SHA = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/
const FILE_LINE = /[\w./-]+\.[\w]+:\d+/
const citesFix = (note) => SHA.test(note) && FILE_LINE.test(note)
const citesReply = (note, people) => [...note.matchAll(/@([\w-]+)/g)].some((m) => people.has(m[1].toLowerCase()))

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

const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * The output without its STATUS lines (they are shown in the recap instead). A code block that held only STATUS lines
 * goes with them; every other block, even an empty one the model wrote, stays exactly as written.
 */
export function stripStatusLines(output) {
  const kept = [] // {line, block}: block lines are kept byte for byte
  let block = null // {fence, lines, stripped}: the code block being read
  for (const line of String(output).split(/\r?\n/)) {
    const fence = FENCE.exec(line)?.[1]
    if (block === null) {
      if (fence) block = { fence, lines: [line], stripped: false }
      else if (!STATUS_LINE.test(line.trim())) kept.push({ line, block: false })
      continue
    }
    if (fence && fence[0] === block.fence[0] && fence.length >= block.fence.length && line.trim() === fence) {
      block.lines.push(line)
      const emptied = block.stripped && block.lines.slice(1, -1).every((l) => l.trim() === '')
      if (!emptied) kept.push(...block.lines.map((l) => ({ line: l, block: true })))
      block = null
    } else if (STATUS_LINE.test(line.trim())) {
      block.stripped = true
    } else {
      block.lines.push(line)
    }
  }
  if (block !== null) kept.push(...block.lines.map((l) => ({ line: l, block: true })))
  // Removing lines can leave runs of blank lines between blocks: collapse those, never a blank line inside a block.
  const lines = kept.filter((entry, i) => entry.block || entry.line.trim() !== '' || !(kept[i - 1] && !kept[i - 1].block && kept[i - 1].line.trim() === ''))
  return lines.map((entry) => entry.line).join('\n').trim()
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
export function advanceLedger(previous, results, { repliers = [] } = {}) {
  const people = new Set(repliers.map((login) => login.toLowerCase()))
  const ledger = structuredClone(previous ?? emptyLedger())
  ledger.round += 1
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
      let answer = statuses.get(finding.id)
      // A blocking finding is closed as RESOLVED only with its evidence cited, a commit and a file:line: the model's
      // word alone keeps it open.
      if (answer?.status === 'resolved' && finding.blocking && !citesFix(answer.note)) {
        answer = { status: 'open', note: `RESOLVED without a commit and file:line cited: ${answer.note}`.slice(0, MAX_TEXT) }
      }
      // And as ANSWERED only when it names (@login) a person who actually commented on the pull request.
      if (answer?.status === 'answered' && finding.blocking && !citesReply(answer.note, people)) {
        answer = { status: 'open', note: `ANSWERED without naming the author's reply (@login): ${answer.note}`.slice(0, MAX_TEXT) }
      }
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
    // A finding the model raises again although it is still open is the same finding, not a new one: convergence must
    // not depend on the model obeying "never repeat".
    // Keyed on place and title, not severity: the same problem re-raised as a MUST-FIX stays the same finding.
    const key = (where, title) => `${text(where)}|${text(title)}`.toLowerCase()
    const openByKey = new Map(entry.stillOpen.map((f) => [key(f.where, f.title), f]))
    for (const item of [...result.verdict.blocking, ...result.verdict.others]) {
      const same = openByKey.get(key(item.where, item.title))
      if (same) {
        // Re-raised as blocking: the open finding is promoted, never the other way round.
        if (complete.has(item) && !same.blocking) Object.assign(same, { blocking: true, kind: item.kind })
        continue
      }
      const finding = {
        id: `${prefix}${ledger.next[prefix]++}`, pass, kind: item.kind, where: text(item.where), title: text(item.title),
        tenet: item.tenet ? text(item.tenet, 4) : null, blocking: complete.has(item), round: ledger.round, status: 'open', note: '', closedRound: null,
      }
      ledger.findings.push(finding)
      entry.added.push(finding)
    }
  }
  const { kept, dropped } = bound(ledger.findings.filter((f) => f.status === 'open'))
  ledger.findings = kept
  ledger.dropped = dropped + (previous?.dropped ?? 0)
  return { ledger, recap }
}

/**
 * A pass's verdict this round, from what is OPEN now, not only what the model said: a blocking finding still open
 * blocks even when the model's own line says PASS, and a resolved one no longer counts. A pass whose call failed has
 * no verdict of its own (null), but it still BLOCKs while it carries an open blocking finding, so a Bedrock outage can
 * never clear an enforced block.
 */
export function passVerdict(entry, modelVerdict) {
  if (entry.error) return entry.stillOpen.some((f) => f.blocking) ? 'BLOCK' : null
  const live = [...entry.stillOpen, ...entry.added]
  if (live.some((f) => f.blocking)) return 'BLOCK'
  if (modelVerdict === 'INCOMPLETE') return 'INCOMPLETE'
  return live.length > 0 ? 'WARN' : 'PASS'
}
