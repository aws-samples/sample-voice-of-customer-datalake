/**
 * `company` pack write tools: company context (admin), the caller's own
 * objectives & KPIs, and the design system's tokens + guidelines (admin).
 * Logo, references and Figma/GitHub tokens are deliberately NOT writable by
 * the assistant — uploads and secrets stay in the Settings UI.
 *
 * Lists are complete replacements (the SPA PUTs them as sent), so the
 * descriptions tell the model to read first and send everything.
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idSchema } from '../spec.js';
import { defineClientTool, isoDateSchema, presentParts, stringProperty } from './define.js';

// jscpd:ignore-start — mirrors frontend/src/assistant/approvals/companySchemas.ts on purpose: separate packages, pinned by newTools.lockstep.test.ts
const COMPANY_LIMITS = {
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

const title = z.string().trim().min(1).max(COMPANY_LIMITS.maxTitleChars);
const objectiveDescription = z.string().max(COMPANY_LIMITS.maxObjectiveDescriptionChars);

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

const kpiSchema = z.object({
  name: z.string().trim().min(1).max(COMPANY_LIMITS.maxKpiNameChars),
  target: z.union([z.number(), z.string().trim().min(1).max(COMPANY_LIMITS.maxKpiTargetChars)]),
  unit: z.string().trim().min(1).max(COMPANY_LIMITS.maxKpiUnitChars).optional(),
}).strict();

const personalObjectiveSchema = z.object({
  id: idSchema.optional(),
  title,
  description: objectiveDescription,
  due: isoDateSchema.optional(),
  kpis: z.array(kpiSchema).max(COMPANY_LIMITS.maxKpisPerObjective),
}).strict();

const tokenName = z.string().trim().min(1).max(COMPANY_LIMITS.maxTokenNameChars);
const tokenValue = z.string().trim().min(1).max(COMPANY_LIMITS.maxTokenValueChars);
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
// jscpd:ignore-end of the accepted pair

const updateCompanyContext = defineClientTool({
  name: 'update_company_context',
  pack: 'company',
  description: 'Change the company vision and/or objectives (admin). Read get_company_context first. `objectives` '
    + 'REPLACES the whole list: send every objective to keep (with its id), new ones without id. horizon: long | '
    + 'quarter | date (date needs due, YYYY-MM-DD).',
  properties: {
    vision: stringProperty('The full vision (markdown).', COMPANY_LIMITS.maxVisionChars),
    objectives: {
      type: 'array',
      maxItems: COMPANY_LIMITS.maxObjectives,
      items: { type: 'object' },
      description: 'The complete list: [{id?, title, description, horizon, due?}].',
    },
  },
  required: [],
  schema: z.object({
    vision: z.string().max(COMPANY_LIMITS.maxVisionChars).optional(),
    objectives: z.array(companyObjectiveSchema).max(COMPANY_LIMITS.maxObjectives).optional(),
  }).strict().refine((args) => args.vision !== undefined || args.objectives !== undefined, 'give vision or objectives'),
  summarize: (args) => `Update the company context: ${presentParts([
    args.vision !== undefined && 'vision',
    args.objectives !== undefined && `${args.objectives.length} objectives`,
  ])}.`,
});

const updateMyContext = defineClientTool({
  name: 'update_my_context',
  pack: 'company',
  description: 'Change the signed-in user\u2019s OWN objectives and KPIs (never the company ones). Read '
    + 'get_my_context first; `objectives` REPLACES the whole list: [{id?, title, description, due?, kpis: [{name, '
    + 'target, unit?}]}].',
  properties: {
    objectives: {
      type: 'array',
      maxItems: COMPANY_LIMITS.maxObjectives,
      items: { type: 'object' },
      description: 'The complete list of the user\u2019s objectives.',
    },
  },
  required: ['objectives'],
  schema: z.object({ objectives: z.array(personalObjectiveSchema).max(COMPANY_LIMITS.maxObjectives) }).strict(),
  summarize: (args) => `Save your objectives & KPIs (${args.objectives.length} objective${args.objectives.length === 1 ? '' : 's'}).`,
});

const updateDesignSystem = defineClientTool({
  name: 'update_design_system',
  pack: 'company',
  description: 'Change the company design system\u2019s tokens and/or guidelines (admin). Read get_design_system '
    + 'first; `tokens` REPLACES all tokens: {colors: [{name, value}], typography: [{role, family, size?, weight?}], '
    + 'spacing?: [{name, value}], radius?: [{name, value}]}. Logo, references and integration tokens are changed in '
    + 'Settings, not here.',
  properties: {
    tokens: { type: 'object', description: 'The complete token set.' },
    guidelines: stringProperty('The full guidelines (markdown).', COMPANY_LIMITS.maxGuidelinesChars),
  },
  required: [],
  schema: z.object({
    tokens: designTokensSchema.optional(),
    guidelines: z.string().max(COMPANY_LIMITS.maxGuidelinesChars).optional(),
  }).strict().refine((args) => args.tokens !== undefined || args.guidelines !== undefined, 'give tokens or guidelines'),
  summarize: (args) => `Update the design system: ${presentParts([
    args.tokens !== undefined && `tokens (${args.tokens.colors.length} colors, ${args.tokens.typography.length} type styles)`,
    args.guidelines !== undefined && 'guidelines',
  ])}.`,
});

export function createCompanyClientTools(): ClientToolDefinition[] {
  return [updateCompanyContext, updateMyContext, updateDesignSystem];
}
