/**
 * Card text wraps, it is never cut (wave 4, owner request; WCAG 1.4.4 / 1.4.10 / 1.4.12).
 *
 * A crawl of the f2 pages at 1440 / 1024 / 768 / 390 px and 200 % text found these
 * labels clipped by `truncate` / `line-clamp-1` (a web-review card at 390 px showed
 * no name at all once its badges took the row). Each now wraps — `overflow-wrap:
 * anywhere` for URLs, ids and e-mails — and this pins the element that carries the
 * text: none of them may go back to a one-line cut. A dense description may clamp at
 * two lines, never one, and keeps its full text in `title`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const lineWith = (file: string, marker: string): string =>
  readFileSync(join(SRC, file), 'utf8').split('\n').find((line) => line.includes(marker)) ?? ''

const CUT = /\btruncate\b|\bline-clamp-1\b/

describe.each([
  ['pages/Scrapers/AppConfigComponents.tsx', '>{name}</h2>'],
  ['pages/Scrapers/AppConfigComponents.tsx', '>{identifier}</p>'],
  ['pages/Scrapers/ScraperCard.tsx', '>{scraper.name}</h2>'],
  ['pages/Scrapers/ScraperCard.tsx', '>{domain}</p>'],
  ['pages/Scrapers/SourceCardParts.tsx', '<dd className='],
  ['pages/Settings/SourceCard.tsx', '{manifest.description}</span>'],
  ['pages/Settings/AlertsCard.tsx', '{recipient.email}</span>'],
  ['pages/Projects/ProjectCard.tsx', '>{project.name}</h2>'],
  ['pages/ProjectDetail/ProjectHeader.tsx', '>{name}</h1>'],
  ['pages/Agents/Agents.tsx', '>{agent.name}</p>'],
  ['pages/Agents/Agents.tsx', 'agent.description === \'\' ? undefined'],
  ['pages/Agents/WorkflowLibrary.tsx', '>{workflow.name}</p>'],
  ['pages/Agents/RunsTab.tsx', 't(`run.triggers.${run.trigger}`)'],
  ['pages/Company/DesignReferences.tsx', 'reference.title ||'],
  ['components/CategoriesManager/CategoryRow.tsx', 'hover:text-accent-text'],
])('%s — %s', (file, marker) => {
  it('wraps instead of cutting the text to one line', () => {
    const line = lineWith(file, marker)
    expect(line).not.toBe('')
    expect(line).not.toMatch(CUT)
  })
})
