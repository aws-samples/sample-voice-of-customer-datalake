/**
 * @fileoverview Company context (vision + objectives) and the caller's own
 * objectives & KPIs.
 *
 * - `GET /settings/company-context` — any signed-in user reads it; `PUT` is
 *   admin-only server-side (the SPA also renders it read-only for others).
 * - `GET|PUT /settings/my-context` — the caller's personal objectives and KPIs.
 *   They feed that user's personal memory and the assistant; they can never edit
 *   or delete the company ones.
 *
 * Every response is normalized through lenient Zod schemas: a drifted row is
 * dropped, a drifted field takes its default, and the section never crashes.
 *
 * @module api/companyContextApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText as text, optionalText, parsedList } from './schemaList'

/** Server limits, mirrored so the editor can stop the user before a 400. */
export const MAX_VISION_CHARS = 20_000
export const MAX_COMPANY_OBJECTIVES = 50

export const OBJECTIVE_HORIZONS = ['long', 'quarter', 'date'] as const
export type ObjectiveHorizon = typeof OBJECTIVE_HORIZONS[number]

const CompanyObjectiveSchema = z.object({
  id: z.string().min(1),
  title: text,
  description: text,
  horizon: z.enum(OBJECTIVE_HORIZONS).catch('long'),
  due: optionalText,
})
export type CompanyObjective = z.output<typeof CompanyObjectiveSchema>

const CompanyContextSchema = z.object({
  vision: text,
  objectives: parsedList(CompanyObjectiveSchema),
  updated_at: optionalText,
  updated_by_username: optionalText,
}).catch({ vision: '', objectives: [] })
export type CompanyContext = z.output<typeof CompanyContextSchema>

/** A KPI target is free text on purpose ("95%", "< 2 days", "4.5"). */
const KpiSchema = z.object({
  name: z.string().min(1),
  target: z.union([z.string(), z.number()]).transform(String).catch(''),
  unit: optionalText,
})
export type Kpi = z.output<typeof KpiSchema>

const PersonalObjectiveSchema = z.object({
  id: z.string().min(1),
  title: text,
  description: text,
  due: optionalText,
  kpis: parsedList(KpiSchema),
})
export type PersonalObjective = z.output<typeof PersonalObjectiveSchema>

const MyContextSchema = z.object({
  objectives: parsedList(PersonalObjectiveSchema),
}).catch({ objectives: [] })
export type MyContext = z.output<typeof MyContextSchema>

export function normalizeCompanyContext(raw: unknown): CompanyContext {
  return CompanyContextSchema.parse(raw)
}

export function normalizeMyContext(raw: unknown): MyContext {
  return MyContextSchema.parse(raw)
}

/** The PUT body: only the editable fields, blank rows dropped, `due` only for dated objectives. */
export function companyContextBody(context: Pick<CompanyContext, 'vision' | 'objectives'>) {
  return {
    vision: context.vision,
    objectives: context.objectives
      .filter((o) => o.title.trim() !== '')
      .map(({ id, title, description, horizon, due }) => ({
        id, title: title.trim(), description, horizon,
        ...(horizon === 'date' && due !== undefined ? { due } : {}),
      })),
  }
}

export function myContextBody(context: MyContext) {
  return {
    objectives: context.objectives
      .filter((o) => o.title.trim() !== '')
      .map(({ id, title, description, due, kpis }) => ({
        id, title: title.trim(), description,
        ...(due === undefined ? {} : { due }),
        kpis: kpis
          .filter((k) => k.name.trim() !== '')
          .map(({ name, target, unit }) => ({ name: name.trim(), target, ...(unit === undefined ? {} : { unit }) })),
      })),
  }
}

export const companyContextKey = () => ['company-context'] as const
export const myContextKey = () => ['my-context'] as const

export const companyContextApi = {
  getCompanyContext: async (): Promise<CompanyContext> =>
    normalizeCompanyContext(await fetchApi<unknown>('/settings/company-context')),

  saveCompanyContext: async (context: Pick<CompanyContext, 'vision' | 'objectives'>): Promise<CompanyContext> =>
    normalizeCompanyContext(await fetchApi<unknown>('/settings/company-context', {
      method: 'PUT',
      body: JSON.stringify(companyContextBody(context)),
    })),

  getMyContext: async (): Promise<MyContext> =>
    normalizeMyContext(await fetchApi<unknown>('/settings/my-context')),

  saveMyContext: async (context: MyContext): Promise<MyContext> =>
    normalizeMyContext(await fetchApi<unknown>('/settings/my-context', {
      method: 'PUT',
      body: JSON.stringify(myContextBody(context)),
    })),
}
