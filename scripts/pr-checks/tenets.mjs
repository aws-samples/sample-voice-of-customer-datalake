/**
 * The `## Tenets` section of a pull request description (TENETS.md → "Pull request checklist").
 *
 * Every PR names the tenets it touches on one line, `Tenets touched: 3, D1, D4` (or `none`), so a
 * reviewer knows which bar to hold it to. FORM only, like the rest of check-pr-body.mjs: it cannot tell
 * whether the list is right, only that it is there and names real tenets.
 *
 * TENET_IDS is the list TENETS.md defines; tenets.test.mjs pins the two together (a tenet added to the file
 * must be added here, and the reverse), so this module never reads the file at run time: the PR check runs
 * the DEFAULT branch's copy of this script against the PR's description only.
 */
import { contentLines, findSection, plainLine } from './markdown.mjs'

/** Product tenets 1-7 and data lake tenets D1-D7, as TENETS.md numbers them. */
export const TENET_IDS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'])
const TOUCHED = /^tenets touched:\s*(.*)$/i
const NONE = /^none\b/i

/** The ids a `Tenets touched:` value names, in order: `3, D1 and d4` → `['3', 'D1', 'D4']`. */
export function touchedIds(value) {
  return (value.match(/\bD?\d+\b/gi) ?? []).map((id) => id.toUpperCase())
}

/** Problems with the `## Tenets` section of a description's sections (empty when it is fine). */
export function tenetsProblems(all) {
  const section = findSection(all, 'Tenets')
  if (section === null) return ['missing section "## Tenets": name the tenets the PR touches (TENETS.md → Pull request checklist)']
  const lines = contentLines(section).map(plainLine).map((line) => TOUCHED.exec(line)).filter(Boolean)
  if (lines.length !== 1) return ['Tenets: write exactly one line `Tenets touched: <ids, e.g. 3, D1> | none`']
  const value = lines[0][1].trim()
  if (NONE.test(value)) return []
  const ids = touchedIds(value)
  if (ids.length === 0) return ['Tenets: `Tenets touched:` names no tenet; list ids (1-7, D1-D7) or write `none`']
  const unknown = ids.filter((id) => !TENET_IDS.includes(id))
  return unknown.length === 0 ? [] : [`Tenets: ${unknown.join(', ')} is not a tenet in TENETS.md (1-7, D1-D7)`]
}
