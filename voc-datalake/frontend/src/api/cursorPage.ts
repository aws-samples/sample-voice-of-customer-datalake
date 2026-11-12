/**
 * @fileoverview The lenient read of a `{<rows>: [...], next_cursor}` answer (the members of a workspace, the
 * platform console's workspaces): the rows this build can read, in the server's order, and the next page's cursor.
 * A row that does not match `schema` is left out; an answer with no list reads as an empty last page.
 *
 * @module api/cursorPage
 */
import { z } from 'zod'

export interface CursorPage<Row> {
  readonly rows: Row[]
  /** The next page's cursor, or null on the last page. */
  readonly nextCursor: string | null
}

const AnswerSchema = z.record(z.string(), z.unknown())
const CursorSchema = z.string().min(1).nullable().catch(null)

export function readCursorPage<Row>(raw: unknown, field: string, schema: z.ZodType<Row>): CursorPage<Row> {
  const answer = AnswerSchema.safeParse(raw)
  const list = answer.success ? answer.data[field] : undefined
  if (!answer.success || !Array.isArray(list)) return { rows: [], nextCursor: null }
  const rows = list.flatMap((row: unknown) => {
    const read = schema.safeParse(row)
    return read.success ? [read.data] : []
  })
  return { rows, nextCursor: CursorSchema.parse(answer.data['next_cursor'] ?? null) }
}
