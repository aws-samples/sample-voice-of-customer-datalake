/**
 * @fileoverview REST executors (and the current-value reads their previews
 * show) for the `company` pack: company context (admin), the caller's own
 * objectives & KPIs, and the design system's tokens + guidelines (admin).
 *
 * The PUT routes take whole documents, so a field the model did not send is
 * filled from the CURRENT stored value read at execution time (company
 * context: vision / objectives; design system: tokens / guidelines). The
 * Settings Lambda enforces admin-only and the size limits.
 *
 * @module assistant/approvals/companyExecutors
 */
import { fetchApi } from '../../api/client'
import { invalidateKeys, keysFor } from './invalidation'
import { isRecord } from './previews/format'
import type { WriteToolExecutionContext } from '../types'
import type { UpdateCompanyContextArgs, UpdateDesignSystemArgs, UpdateMyContextArgs } from './companySchemas'

const COMPANY_CONTEXT = '/settings/company-context'
const MY_CONTEXT = '/settings/my-context'
const DESIGN_SYSTEM = '/settings/design-system'

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) })

/** A settings document as a plain record ({} when the route answered something else). */
async function readRecord(endpoint: string): Promise<Record<string, unknown>> {
  const raw = await fetchApi<unknown>(endpoint)
  return isRecord(raw) ? raw : {}
}

export const readCompanyContext = () => readRecord(COMPANY_CONTEXT)
export const readMyContext = () => readRecord(MY_CONTEXT)
export const readDesignSystem = () => readRecord(DESIGN_SYSTEM)

const listOr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export async function updateCompanyContext(args: UpdateCompanyContextArgs, ctx: WriteToolExecutionContext) {
  const current = args.vision === undefined || args.objectives === undefined ? await readCompanyContext() : {}
  const body = {
    vision: args.vision ?? (typeof current.vision === 'string' ? current.vision : ''),
    objectives: args.objectives ?? listOr(current.objectives),
  }
  await fetchApi<unknown>(COMPANY_CONTEXT, put(body))
  void invalidateKeys(ctx.queryClient, keysFor.companyContext())
  const parts = [args.vision === undefined ? null : 'vision', args.objectives === undefined ? null : `${args.objectives.length} objectives`]
  return { summary: `Saved the company context (${parts.filter((p) => p !== null).join(', ')}).` }
}

export async function updateMyContext(args: UpdateMyContextArgs, ctx: WriteToolExecutionContext) {
  await fetchApi<unknown>(MY_CONTEXT, put({ objectives: args.objectives }))
  void invalidateKeys(ctx.queryClient, keysFor.myContext())
  return { summary: `Saved your objectives & KPIs (${args.objectives.length} objectives).` }
}

export async function updateDesignSystem(args: UpdateDesignSystemArgs, ctx: WriteToolExecutionContext) {
  const current = args.tokens === undefined || args.guidelines === undefined ? await readDesignSystem() : {}
  const body = {
    tokens: args.tokens ?? (isRecord(current.tokens) ? current.tokens : { colors: [], typography: [] }),
    guidelines: args.guidelines ?? (typeof current.guidelines === 'string' ? current.guidelines : ''),
  }
  await fetchApi<unknown>(DESIGN_SYSTEM, put(body))
  void invalidateKeys(ctx.queryClient, keysFor.designSystem())
  const parts = [args.tokens === undefined ? null : 'tokens', args.guidelines === undefined ? null : 'guidelines']
  return { summary: `Saved the design system (${parts.filter((p) => p !== null).join(', ')}).` }
}
