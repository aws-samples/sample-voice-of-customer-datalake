/**
 * @fileoverview The engineering agents' skills library (7.56.00, administrators only, while the engineering agents are
 * on; `lambda/shared/agents_engineering_registry_routes.py`), read from the orchestration bundle the Lambdas ship
 * (`templates/orchestration/skills/<name>/`, compiled):
 * - `GET /agents/engineering/skill-library` → `{skills}`: each skill's description, source, licence, what was adapted,
 *   the roles that use it and its reference files, WITHOUT their text;
 * - `GET …/skill-library/<name>` → its SKILL.md (front matter included); `?reference=references/<file>.md` → one of its
 *   reference files; 404 for no such skill or reference.
 *
 * Every text is the server's as data: the Skills tab's Library shows it through the document component (safe
 * Markdown), never as HTML.
 *
 * @module api/engineeringSkillLibraryApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { eachOf, parseEach } from './lenientFields'
import { parsedAnswer } from './strictAnswer'
import { isRecord } from '../lib/typeGuards'

/** A file's digest and size, as the bundle compiled them. */
const fileFields = { digest: z.string().catch(''), bytes: z.number().int().nonnegative().catch(0) }
const text = z.string().catch('')

const ReferenceSchema = z.object({ path: z.string().min(1), ...fileFields })

const LibrarySkillSchema = z.object({
  name: z.string().min(1),
  description: text,
  /** Where it was vendored from (`ai-skill-factory 2.0.0 (Amit Deol), skills/tdd`). */
  source: text,
  license: text,
  /** What was changed from the source, in one line. */
  adapted: text,
  path: text,
  ...fileFields,
  /** The roles whose cards name it (the agent catalog's order). */
  roles: z.array(z.string()).catch([]),
  references: eachOf(ReferenceSchema),
})
export type LibrarySkill = z.output<typeof LibrarySkillSchema>

const LibraryFileSchema = z.object({
  name: z.string().min(1),
  /** null: the skill's SKILL.md; else the reference file's path within the skill (`references/<file>.md`). */
  reference: z.string().nullable().catch(null),
  path: text,
  text: z.string(),
  ...fileFields,
})
export type LibraryFile = z.output<typeof LibraryFileSchema>

/** An answer with no list where the list should be is an error, never "no skills" (a false statement). */
export function parseLibrary(raw: unknown): LibrarySkill[] {
  if (!isRecord(raw) || !Array.isArray(raw.skills)) throw new Error('The skills library answer was unreadable')
  return parseEach(LibrarySkillSchema, raw.skills)
}

/** A file read strictly: one without its text is an error, never an empty skill. */
export function parseLibraryFile(raw: unknown): LibraryFile {
  return parsedAnswer(LibraryFileSchema, raw, 'skill file')
}

const LIBRARY_PATH = '/agents/engineering/skill-library'
const fileQuery = (reference: string | null) => (reference === null ? '' : `?${new URLSearchParams({ reference }).toString()}`)
const filePath = (name: string, reference: string | null) => `${LIBRARY_PATH}/${encodeURIComponent(name)}${fileQuery(reference)}`

export const engineeringSkillLibraryKeys = {
  list: () => ['engineering-skill-library', 'list'] as const,
  file: (name: string, reference: string | null) => ['engineering-skill-library', 'file', name, reference ?? ''] as const,
}

export const engineeringSkillLibraryApi = {
  list: async (): Promise<LibrarySkill[]> => parseLibrary(await fetchApi<unknown>(LIBRARY_PATH)),
  file: async (name: string, reference: string | null): Promise<LibraryFile> =>
    parseLibraryFile(await fetchApi<unknown>(filePath(name, reference))),
}
