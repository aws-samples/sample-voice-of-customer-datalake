/**
 * The full tool catalogue in its ONE canonical order: pack order
 * (`TOOL_PACKS`), and within a pack the server tools in `SERVER_TOOLS` order,
 * then the client tools in `CLIENT_TOOLS` order. Order comes from the contract,
 * not from the definition files, so the Bedrock tool list is stable across
 * deploys (prompt-cache friendly) and a contract change shows up here.
 */
import { CLIENT_TOOLS, SERVER_TOOLS, TOOL_PACKS } from '../contract.js';
import type { AssistantToolDefinition } from '../types.js';
import { createAgentsClientTools } from './client/agents.js';
import { createCompanyClientTools } from './client/company.js';
import { createCoreMemoryClientTools, createMemoryClientTools } from './client/memory.js';
import { createProjectClientTools } from './client/project.js';
import { createScraperClientTools } from './client/scrapers.js';
import { createRadarClientTools } from './client/radar.js';
import { createUserClientTools } from './client/users.js';
import { createReviewImportClientTools } from './client/review-import.js';
import { createWorkspaceClientTools } from './client/workspace.js';
import { createPlanClientTools } from './client/plan.js';
import { createPlanWriteClientTools } from './client/plan-writes.js';
import { getDefaultToolDeps, type ToolDeps } from './deps.js';
import { ConfigurationError } from '../../lib/errors.js';
import { createAgentsServerTools } from './server/agents.js';
import { createCompanyServerTools } from './server/company.js';
import { createRadarServerTools } from './server/radar.js';
import { createCoreServerTools } from './server/core.js';
import { createInsightsServerTools } from './server/insights.js';
import { createMemoryServerTools } from './server/memory.js';
import { createProjectServerTools } from './server/project.js';
import { createUserServerTools } from './server/users.js';
import { createWorkspaceServerTools } from './server/workspace.js';
import { createPlanServerTools } from './server/plan.js';
import { createSourceServerTools } from './server/source-tools.js';

export function buildCatalogue(deps: ToolDeps): AssistantToolDefinition[] {
  // The plan tools read the finished catalogue (plan_catalogue lists it, plan_lookup runs its reads,
  // propose_plan checks literals against its schemas); they only read it when called, after this returns.
  const built: { tools: readonly AssistantToolDefinition[] } = { tools: [] };
  const catalogue = () => built.tools;
  const definitions: AssistantToolDefinition[] = [
    ...createCoreServerTools(deps),
    ...createPlanServerTools(deps, catalogue),
    ...createSourceServerTools(deps),
    ...createMemoryServerTools(deps),
    ...createInsightsServerTools(deps),
    ...createProjectServerTools(deps),
    ...createWorkspaceServerTools(deps),
    ...createUserServerTools(deps),
    ...createAgentsServerTools(deps),
    ...createCompanyServerTools(deps),
    ...createRadarServerTools(deps),
    ...createProjectClientTools(),
    ...createWorkspaceClientTools(),
    ...createScraperClientTools(deps),
    ...createRadarClientTools(deps),
    ...createUserClientTools(deps),
    ...createReviewImportClientTools(deps),
    ...createCoreMemoryClientTools(),
    ...createMemoryClientTools(),
    ...createAgentsClientTools(),
    ...createCompanyClientTools(),
    ...createPlanClientTools(catalogue),
    ...createPlanWriteClientTools(),
  ];
  const byName = new Map<string, AssistantToolDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) throw new ConfigurationError(`Duplicate assistant tool: ${definition.name}`);
    byName.set(definition.name, definition);
  }
  const ordered = TOOL_PACKS.flatMap((pack) => [...SERVER_TOOLS[pack], ...CLIENT_TOOLS[pack]].map((name) => {
    const definition = byName.get(name);
    if (definition?.pack !== pack) throw new ConfigurationError(`Assistant tool ${name} is missing from pack ${pack}`);
    return definition;
  }));
  if (ordered.length !== definitions.length) {
    throw new ConfigurationError('The assistant catalogue defines tools the contract does not name');
  }
  built.tools = ordered;
  return ordered;
}

const holder: { catalogue: AssistantToolDefinition[] | null } = { catalogue: null };

/** The process-wide catalogue (built once per container). */
export function getDefaultCatalogue(): AssistantToolDefinition[] {
  holder.catalogue ??= buildCatalogue(getDefaultToolDeps());
  return holder.catalogue;
}
