/**
 * `company` pack server tools — company context (vision, objectives), the
 * caller's own objectives & KPIs, and the company design system. All are
 * routes of the settings Lambda, read as the caller (any signed-in user may
 * read). Of the design system's integrations only the connected flags
 * `{figma, github}` are passed on — the tokens are write-only and must never
 * reach the prompt, even if a response ever carried them.
 */
import { z } from 'zod';
import type { ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { isRecord, jsonResult } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import { getSettingsRoute, serverTool } from './common.js';

/** Vision (≤ 20k chars) + 50 objectives fit comfortably; design-system guidelines can be long too. */
const COMPANY_RESULT_BUDGET = 30_000;

/** `integrations` reduced to booleans: `{figma: bool, github: bool}`, whatever the response held. */
function withSafeIntegrations(body: unknown): unknown {
  if (!isRecord(body) || !('integrations' in body)) return body;
  const integrations = isRecord(body.integrations) ? body.integrations : {};
  return { ...body, integrations: { figma: integrations.figma === true, github: integrations.github === true } };
}

const READS = [
  {
    name: 'get_company_context',
    route: 'company-context',
    description: 'The company vision (markdown) and objectives (id, title, description, horizon long|quarter|date, '
      + 'due). Use it to judge what serves the company and to break ties; read it before proposing '
      + 'update_company_context.',
  },
  {
    name: 'get_my_context',
    route: 'my-context',
    description: 'The signed-in user\u2019s own objectives and KPIs (id, title, description, due, kpis: [{name, '
      + 'target, unit}]). Read it before proposing update_my_context.',
  },
  {
    name: 'get_design_system',
    route: 'design-system',
    description: 'The company design system: tokens (colors, typography, spacing, radius), guidelines (markdown), '
      + 'logo, references (screenshots, HTML, Figma, GitHub with extracted summaries) and which integrations are '
      + 'connected. Read it before proposing update_design_system.',
  },
] as const;

export function createCompanyServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return READS.map(({ name, route, description }) => serverTool(name, 'company', toolSpec(name, description, {}), async (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    const body = await getSettingsRoute(deps, ctx, route);
    return { content: jsonResult(withSafeIntegrations(body), COMPANY_RESULT_BUDGET) };
  }));
}
