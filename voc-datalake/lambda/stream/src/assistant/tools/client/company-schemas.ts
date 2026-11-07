/**
 * Argument schemas of the `company` pack write tools (company context, the
 * caller's own objectives & KPIs, the design system's tokens + guidelines), shared
 * with the SPA's approval boundary (`frontend/src/assistant/approvals/companySchemas.ts`
 * imports this module).
 *
 * Pure on purpose: zod and other pure modules only, because the SPA bundles it.
 * The id schema is a parameter: the stream and the SPA each keep their own (the
 * same rule, different messages), and the SPA builds these schemas with its own.
 */
import { z } from 'zod';
import { isoDateSchema, nonEmpty } from './text-schemas.js';

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
} as const;

const OBJECTIVE_HORIZONS = ['long', 'quarter', 'date'] as const;

const title = nonEmpty(COMPANY_LIMITS.maxTitleChars);
const objectiveDescription = z.string().max(COMPANY_LIMITS.maxObjectiveDescriptionChars);

const kpiSchema = z.object({
  name: nonEmpty(COMPANY_LIMITS.maxKpiNameChars),
  target: z.union([z.number(), nonEmpty(COMPANY_LIMITS.maxKpiTargetChars)]),
  unit: nonEmpty(COMPANY_LIMITS.maxKpiUnitChars).optional(),
}).strict();

const tokenName = nonEmpty(COMPANY_LIMITS.maxTokenNameChars);
const tokenValue = nonEmpty(COMPANY_LIMITS.maxTokenValueChars);
const namedTokens = z.array(z.object({ name: tokenName, value: tokenValue }).strict()).max(COMPANY_LIMITS.maxTokensPerGroup);

const designTokensSchema = z.object({
  colors: namedTokens,
  typography: z.array(z.object({
    role: tokenName,
    family: tokenValue,
    size: tokenName.optional(),
    weight: z.union([z.number().int().min(1).max(1000), tokenName]).optional(),
  }).strict()).max(COMPANY_LIMITS.maxTokensPerGroup),
  spacing: namedTokens.optional(),
  radius: namedTokens.optional(),
}).strict();

const updateDesignSystem = z.object({
  tokens: designTokensSchema.optional(),
  guidelines: z.string().max(COMPANY_LIMITS.maxGuidelinesChars).optional(),
}).strict().refine((args) => args.tokens !== undefined || args.guidelines !== undefined, 'give tokens or guidelines');

/** The three company write schemas, built over the caller's id schema. */
export function buildCompanyArgSchemas(idSchema: z.ZodString) {
  /** `id` is kept for existing objectives and omitted for new ones (the API assigns it). */
  const companyObjectiveSchema = z.object({
    id: idSchema.optional(),
    title,
    description: objectiveDescription,
    horizon: z.enum(OBJECTIVE_HORIZONS),
    due: isoDateSchema.optional(),
  }).strict().refine((objective) => objective.horizon !== 'date' || objective.due !== undefined, {
    message: 'an objective with horizon "date" needs due', path: ['due'],
  });

  const personalObjectiveSchema = z.object({
    id: idSchema.optional(),
    title,
    description: objectiveDescription,
    due: isoDateSchema.optional(),
    kpis: z.array(kpiSchema).max(COMPANY_LIMITS.maxKpisPerObjective),
  }).strict();

  const updateCompanyContext = z.object({
    vision: z.string().max(COMPANY_LIMITS.maxVisionChars).optional(),
    objectives: z.array(companyObjectiveSchema).max(COMPANY_LIMITS.maxObjectives).optional(),
  }).strict().refine((args) => args.vision !== undefined || args.objectives !== undefined, 'give vision or objectives');

  const updateMyContext = z.object({
    objectives: z.array(personalObjectiveSchema).max(COMPANY_LIMITS.maxObjectives),
  }).strict();

  return { updateCompanyContext, updateMyContext, updateDesignSystem };
}
