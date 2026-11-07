/**
 * `company` pack write tools: company context (admin), the caller's own
 * objectives & KPIs, and the design system's tokens + guidelines (admin).
 * Logo, references and Figma/GitHub tokens are deliberately NOT writable by
 * the assistant — uploads and secrets stay in the Settings UI.
 *
 * Lists are complete replacements (the SPA PUTs them as sent), so the
 * descriptions tell the model to read first and send everything.
 */
import type { ClientToolDefinition } from '../../types.js';
import { idSchema } from '../spec.js';
import { buildCompanyArgSchemas, COMPANY_LIMITS } from './company-schemas.js';
import { defineClientTool, presentParts, stringProperty } from './define.js';

const schemas = buildCompanyArgSchemas(idSchema);

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
  schema: schemas.updateCompanyContext,
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
  schema: schemas.updateMyContext,
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
  schema: schemas.updateDesignSystem,
  summarize: (args) => `Update the design system: ${presentParts([
    args.tokens !== undefined && `tokens (${args.tokens.colors.length} colors, ${args.tokens.typography.length} type styles)`,
    args.guidelines !== undefined && 'guidelines',
  ])}.`,
});

export function createCompanyClientTools(): ClientToolDefinition[] {
  return [updateCompanyContext, updateMyContext, updateDesignSystem];
}
