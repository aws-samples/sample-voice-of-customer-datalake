/**
 * @fileoverview Agents → Skills → Library's addresses (7.56.00): the library `/agents/skills/library`, one skill
 * `/agents/skills/library/<name>` (its SKILL.md), one of its reference files
 * `/agents/skills/library/<name>/references/<file>`. agentsPaths.ts leaves every place under `library` to this module.
 *
 * @module pages/Agents/skillLibraryPaths
 */
import { pathOf, segmentsUnder } from '../../utils/pathPlace'
import { LIBRARY_SEGMENT } from './agentsPaths'

export interface LibraryPlace {
  /** The skill open, else null (the list). */
  readonly skill: string | null
  /** The reference file open within it (`references/<file>`), else null (its SKILL.md). */
  readonly reference: string | null
}

const LIBRARY = ['agents', 'skills', LIBRARY_SEGMENT] as const
const LIBRARY_PATH = pathOf(LIBRARY)
const REFERENCES = 'references'

/** The path of the library, of one skill, or of one of its references. */
export function libraryPath(place: Partial<LibraryPlace> = {}): string {
  const skill = place.skill ?? null
  if (skill === null) return LIBRARY_PATH
  const reference = place.reference ?? null
  return pathOf([...LIBRARY, skill, ...(reference === null ? [] : reference.split('/'))])
}

/** The library's place a path names; null when the path is not the library's. A path that names more than a skill's
 * `references/<file>` reads as that skill. */
export function readLibraryPlace(pathname: string): LibraryPlace | null {
  const segments = segmentsUnder(LIBRARY_PATH, pathname)
  if (segments === null) return null
  const [skill, folder, file, ...extra] = segments
  const reference = folder === REFERENCES && file !== undefined && extra.length === 0 ? `${REFERENCES}/${file}` : null
  return { skill: skill ?? null, reference }
}
