/**
 * Truncated names keep their full text reachable (design audit D-READ): the
 * audit found `truncate` cutting agent names and descriptions, member e-mails,
 * source schedule values, PR/FAQ and form titles and the workflow name with
 * no tooltip, so the rest of the text was unreadable at 390px. Each of these
 * truncations is a `TruncatedText` (7.51.01: its tooltip shows the whole text
 * while it is cut), or, where the native title still waits for its release
 * (native_title.json: the flow canvas), carries `title` with the same value.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

/** The source line of `file` that renders `child` (throws when it moved, so a pin never passes vacuously). */
function lineOf(file: string, child: string): string {
  const line = readFileSync(resolve(SRC, file), 'utf8').split('\n').find((l) => l.includes(child))
  if (line === undefined) throw new Error(`${child} not found in ${file}`)
  return line
}

/** [file, the JSX expression the truncated element renders] */
const SITES: ReadonlyArray<readonly [string, string]> = [
  // (7.52.00: the Automations row: its name wraps, its one line of what it does is a TruncatedText)
  ['pages/Agents/Automations/AutomationRow.tsx', 'text={agent.description} />'],
  ['components/ProjectSharingModal/MemberList.tsx', 'text={person.email} />'],
  ['pages/Scrapers/SourceCardParts.tsx', '{value}</dd>'],
  // The Prioritization row, document and form titles now WRAP (wave 4), so nothing is cut:
  // pinned by pages/analyticsTextWraps.test.ts instead.
  ['components/WorkflowEditor/EditorParts.tsx', 'text={name} />'],
]

describe.each(SITES)('%s %s', (file, child) => {
  // Wave 4 (WCAG 1.4.4 / 1.4.10): a name may now WRAP instead (no cut at all, cardTextWraps.test.ts);
  // a one-line or clamped cut must still carry its full text: a TruncatedText, or a `title` still waiting.
  it('wraps, or truncates with the full text in a TruncatedText (or a waiting `title`)', () => {
    const line = lineOf(file, child)
    const cut = /\btruncate\b|\bline-clamp-\d\b/.test(line)
    expect(cut ? /<TruncatedText\b|\btitle=/.test(line) : line.includes('break-words')).toBe(true)
  })
})

/** Page subtitles that span the content width (D-READ: up to ~165 characters a line). */
const SUBTITLES: ReadonlyArray<readonly [string, string]> = [
  ['components/PageTitle/PageTitle.tsx', '{subtitle}</p>'],
  ['pages/Settings/Settings.tsx', "{t('subtitle')}</p>"],
  ['pages/Settings/Settings.tsx', "{t(tabHintKey(place.tab))}</p>"],
  ['pages/Prioritization/PrioritizationHeader.tsx', "{t('subtitle')}</p>"],
  ['pages/Projects/Projects.tsx', "{t('description')}</p>"],
]

describe.each(SUBTITLES)('%s subtitle', (file, child) => {
  it('caps its measure at max-w-prose', () => {
    expect(lineOf(file, child)).toContain('max-w-prose')
  })
})
