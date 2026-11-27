/**
 * @fileoverview The platform console's cost per workspace (`GET /platform/costs`; platform admins only, the live
 * check server-side, 403 otherwise; lambda/api/workspaces_handler.py, lambda/shared/platform_costs.py `cost_page`,
 * docs/multi-workspace.md "Cost per workspace").
 *
 * An estimate from list prices, never a bill: a page of workspaces (by name, the listing's cursor), each with the days
 * of the range that had metered calls and a total; the first page also the deployment's own calls (with the
 * workspaces that were not active when a day was rolled up) and the calls no handler attributed. A dollar figure is a
 * decimal string to the millionth, or null while a part with calls is unpriced and nothing is priced.
 *
 * Lenient where it can be honest: a workspace row that does not read is left out and counted (`unreadable`), a
 * malformed dollar figure reads as unpriced and incomplete, and a missing `complete` as incomplete. An answer with no
 * page (no list, no range, no estimate flag, no readable `next_cursor`), or a first page whose deployment rows (the
 * inactive workspaces' part included) do not read, is an error, never "no cost".
 *
 * @module api/platformCostsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { eachOf } from './lenientFields'
import type { CursorPage } from './cursorPage'
import { isRecord } from '../lib/typeGuards'

/** A UTC day, `YYYY-MM-DD`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/u
/** `usd_text` in platform_costs.py: a decimal string. */
const USD = /^-?\d+(?:\.\d+)?$/u

const count = z.number().int().nonnegative().catch(0)
const SUM_SHAPE = {
  calls: count,
  input_tokens: count,
  output_tokens: count,
  cache_read_tokens: count,
  cache_write_tokens: count,
  estimated_usd: z.string().regex(USD).nullable(),
  complete: z.boolean().catch(false),
  unpriced_models: z.array(z.string()).catch([]),
}

/** A sum whose dollar figure is not a decimal string or null (missing, a number, `"1,25"`): its dollars are not known,
 * so it reads as unpriced AND incomplete, never as a complete figure that a month total would silently leave out. */
function withDriftMarked(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const usd = raw.estimated_usd
  const readable = usd === null || (typeof usd === 'string' && USD.test(usd))
  return readable ? raw : { ...raw, estimated_usd: null, complete: false }
}

/** A sum (`_Sum.public` in platform_costs.py) with `extra` fields beside its counts and estimate. */
const sumWith = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z.preprocess(withDriftMarked, z.object({ ...SUM_SHAPE, ...extra }))

const SumSchema = sumWith({})
export type CostSum = z.output<typeof SumSchema>

const DaySchema = sumWith({ date: z.string().regex(DAY) })
export type CostDay = z.output<typeof DaySchema>

const ModelLineSchema = sumWith({ model_id: z.string(), service_tier: z.string().catch('') })
const TotalSchema = sumWith({ by_model: eachOf(ModelLineSchema) })

const SummarySchema = z.object({ days: eachOf(DaySchema), total: TotalSchema })
export type CostSummary = z.output<typeof SummarySchema>

const WorkspaceCostSchema = SummarySchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().catch(''),
  status: z.string().catch(''),
})
type WorkspaceCost = z.output<typeof WorkspaceCostSchema>

// (`_deployment_summary` always sends `deleted_workspaces`: one that does not read makes the deployment entry
// unreadable, so the first page is an error rather than a page without the inactive workspaces' row)
const DeploymentCostSchema = SummarySchema.extend({ deleted_workspaces: SumSchema })
type DeploymentCost = z.output<typeof DeploymentCostSchema>

const EnvelopeSchema = z.object({
  // (`label`, the server's `ESTIMATE_LABEL` in English, is not read: the page says it in the reader's language)
  estimate: z.literal(true),
  currency: z.string().min(1).catch('USD'),
  price_as_of: z.string().catch(''),
  price_source: z.string().catch(''),
  from: z.string().regex(DAY),
  to: z.string().regex(DAY),
  workspaces: z.array(z.unknown()),
  // (no catch: a drifted cursor would end the paging silently, the later workspaces left out unsaid)
  next_cursor: z.string().min(1).nullable(),
})

/** What the whole answer says of itself. */
interface CostMeta {
  readonly currency: string
  /** The day the list prices were read (YYYY-MM-DD), and where. */
  readonly priceAsOf: string
  readonly priceSource: string
  readonly from: string
  readonly to: string
}

export interface CostPage extends CursorPage<WorkspaceCost> {
  readonly meta: CostMeta
  /** The first page's alone (null on a later page). */
  readonly deployment: DeploymentCost | null
  readonly unattributed: CostSummary | null
  /** Workspace rows of this page that did not read and are not shown. */
  readonly unreadable: number
}

/** The range asked for: UTC days, both ends included (at most `MAX_RANGE_DAYS`, the server's 92). */
export interface CostRange {
  readonly from: string
  readonly to: string
}

const UNREADABLE = 'The cost answer was unreadable'

/** The first page's deployment or unattributed entry: absent on a later page, an error when it does not read on the first. */
function firstPageEntry<S extends z.ZodType>(schema: S, raw: unknown, firstPage: boolean): z.output<S> | null {
  if (raw === undefined && !firstPage) return null
  const read = schema.safeParse(raw)
  if (read.success) return read.data
  if (firstPage) throw new Error(UNREADABLE)
  return null
}

/** The answer of one page (`firstPage`: no cursor was sent, so the deployment's rows must be there). */
export function parseCostPage(raw: unknown, { firstPage = false }: Readonly<{ firstPage?: boolean }> = {}): CostPage {
  const envelope = EnvelopeSchema.safeParse(raw)
  if (!isRecord(raw) || !envelope.success) throw new Error(UNREADABLE)
  const answer = envelope.data
  const rows = answer.workspaces.flatMap((row: unknown) => {
    const read = WorkspaceCostSchema.safeParse(row)
    return read.success ? [read.data] : []
  })
  return {
    meta: {
      currency: answer.currency, priceAsOf: answer.price_as_of, priceSource: answer.price_source,
      from: answer.from, to: answer.to,
    },
    rows,
    nextCursor: answer.next_cursor,
    deployment: firstPageEntry(DeploymentCostSchema, raw.deployment, firstPage),
    unattributed: firstPageEntry(SummarySchema, raw.unattributed, firstPage),
    unreadable: answer.workspaces.length - rows.length,
  }
}

/** Every page of a range read so far. */
export const platformCostsKey = ({ from, to }: CostRange) => ['platform-costs', from, to] as const

export const platformCostsApi = {
  /** One page of `range` (the server's 20 workspaces), from `cursor` when given. */
  page: async (range: CostRange, cursor: string | null): Promise<CostPage> => {
    const query = new URLSearchParams({ from: range.from, to: range.to })
    if (cursor !== null) query.set('cursor', cursor)
    return parseCostPage(await fetchApi<unknown>(`/platform/costs?${query.toString()}`), { firstPage: cursor === null })
  },
}
