/**
 * @fileoverview Argument schemas of the `company` pack write tools — a strict
 * mirror of `lambda/stream/src/assistant/tools/client/company.ts`. Logo,
 * references and integration tokens are deliberately not writable here.
 *
 * @module assistant/approvals/companySchemas
 */
import { z } from 'zod'
import { idSchema, isoDateSchema, nonEmpty } from './schemas'

// jscpd:ignore-start — mirrors lambda/stream/src/assistant/tools/client/company.ts on purpose: separate packages, pinned by newTools.lockstep.test.ts
/** `COMPANY_LIMITS` in the stream's client/company.ts. */
export const COMPANY_LIMITS = {
  maxVisionChars: 20_000,
  maxObjectives: 50,
  maxTitleChars: 200,
  maxObjectiveDescriptionChars: 2000,
  maxKpisPerObjective: 10,
  maxKpiNameChars: 100,
  maxKpiTargetChars: 100,
  maxKpiUnitChars: 32,
  maxGuidelinesChars: 50_000,
  maxTokensPerGroup: 100,
  maxTokenNameChars: 64,
  maxTokenValueChars: 200,
} as const

const OBJECTIVE_HORIZONS = ['long', 'quarter', 'date'] as const

const title = nonEmpty(COMPANY_LIMITS.maxTitleChars)
const objectiveDescription = z.string().max(COMPANY_LIMITS.maxObjectiveDescriptionChars)

const companyObjectiveSchema = z.strictObject({
  id: idSchema.optional(),
  title,
  description: objectiveDescription,
  horizon: z.enum(OBJECTIVE_HORIZONS),
  due: isoDateSchema.optional(),
}).refine((o) => o.horizon !== 'date' || o.due !== undefined, {
  message: 'an objective with horizon "date" needs due', path: ['due'],
})

const kpiSchema = z.strictObject({
  name: nonEmpty(COMPANY_LIMITS.maxKpiNameChars),
  target: z.union([z.number(), nonEmpty(COMPANY_LIMITS.maxKpiTargetChars)]),
  unit: nonEmpty(COMPANY_LIMITS.maxKpiUnitChars).optional(),
})

const personalObjectiveSchema = z.strictObject({
  id: idSchema.optional(),
  title,
  description: objectiveDescription,
  due: isoDateSchema.optional(),
  kpis: z.array(kpiSchema).max(COMPANY_LIMITS.maxKpisPerObjective),
})

const tokenName = nonEmpty(COMPANY_LIMITS.maxTokenNameChars)
const tokenValue = nonEmpty(COMPANY_LIMITS.maxTokenValueChars)
const namedTokens = z.array(z.strictObject({ name: tokenName, value: tokenValue })).max(COMPANY_LIMITS.maxTokensPerGroup)

const designTokensSchema = z.strictObject({
  colors: namedTokens,
  typography: z.array(z.strictObject({
    role: tokenName,
    family: tokenValue,
    size: tokenName.optional(),
    weight: z.union([z.number().int().min(1).max(1000), tokenName]).optional(),
  })).max(COMPANY_LIMITS.maxTokensPerGroup),
  spacing: namedTokens.optional(),
  radius: namedTokens.optional(),
})
// jscpd:ignore-end of the accepted pair

export const updateCompanyContextArgs = z.strictObject({
  vision: z.string().max(COMPANY_LIMITS.maxVisionChars).optional(),
  objectives: z.array(companyObjectiveSchema).max(COMPANY_LIMITS.maxObjectives).optional(),
}).refine((a) => a.vision !== undefined || a.objectives !== undefined, 'give vision or objectives')

export const updateMyContextArgs = z.strictObject({
  objectives: z.array(personalObjectiveSchema).max(COMPANY_LIMITS.maxObjectives),
})

export const updateDesignSystemArgs = z.strictObject({
  tokens: designTokensSchema.optional(),
  guidelines: z.string().max(COMPANY_LIMITS.maxGuidelinesChars).optional(),
}).refine((a) => a.tokens !== undefined || a.guidelines !== undefined, 'give tokens or guidelines')

export type UpdateCompanyContextArgs = z.infer<typeof updateCompanyContextArgs>
export type UpdateMyContextArgs = z.infer<typeof updateMyContextArgs>
export type UpdateDesignSystemArgs = z.infer<typeof updateDesignSystemArgs>
