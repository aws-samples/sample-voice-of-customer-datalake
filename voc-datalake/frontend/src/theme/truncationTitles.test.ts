/**
 * Truncated names keep their full text reachable (design audit D-READ): the
 * audit found `truncate` cutting agent names and descriptions, member e-mails,
 * source schedule values, PR/FAQ and form titles and the workflow name with
 * no tooltip, so the rest of the text was unreadable at 390px. Each of these
 * one-line truncations now carries `title` with the same value.
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
  ['pages/Agents/Agents.tsx', '{agent.name}</p>'],
  ['pages/Agents/Agents.tsx', ': agent.description}</p>'],
  ['components/ProjectSharingModal/MemberList.tsx', '{person.email}</p>'],
  ['pages/Scrapers/SourceCardParts.tsx', '{value}</dd>'],
  // The Prioritization row, document and form titles now WRAP (wave 4), so nothing is cut:
  // pinned by pages/analyticsTextWraps.test.ts instead.
  ['components/WorkflowEditor/WorkflowEditor.tsx', '{name}</p>'],
]

describe.each(SITES)('%s %s', (file, child) => {
  // Wave 4 (WCAG 1.4.4 / 1.4.10): a name may now WRAP instead (no cut at all, cardTextWraps.test.ts);
  // a one-line or clamped cut must still carry its full text in `title`.
  it('wraps, or truncates with the full text in `title`', () => {
    const line = lineOf(file, child)
    const cut = /\btruncate\b|\bline-clamp-\d\b/.test(line)
    expect(cut ? line.includes('title=') : line.includes('break-words')).toBe(true)
  })
})

/** Page subtitles that span the content width (D-READ: up to ~165 characters a line). */
const SUBTITLES: ReadonlyArray<readonly [string, string]> = [
  ['components/PageTitle/PageTitle.tsx', '{subtitle}</p>'],
  ['pages/Settings/SettingsSections.tsx', "{t('subtitle')}</p>"],
  ['pages/Prioritization/PrioritizationHeader.tsx', "{t('subtitle')}</p>"],
  ['pages/Projects/Projects.tsx', "{t('description')}</p>"],
  ['pages/Agents/Agents.tsx', "{t('list.subtitle')}</p>"],
]

describe.each(SUBTITLES)('%s subtitle', (file, child) => {
  it('caps its measure at max-w-prose', () => {
    expect(lineOf(file, child)).toContain('max-w-prose')
  })
})
