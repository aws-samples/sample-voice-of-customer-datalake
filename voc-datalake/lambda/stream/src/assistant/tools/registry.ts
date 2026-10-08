/**
 * Assistant tool registry — the toolset for one run.
 *
 * Packs come from the page (`packsForPage`, which also drops admin-only packs
 * for non-admins). Tools keep the catalogue's canonical order, so the same page
 * and caller always produce the same Bedrock tool list (prompt-cache friendly).
 * Rules:
 *   - admin-only client tools are dropped for non-admins — always, including
 *     when named in `alsoInclude`;
 *   - `web_search` only when `options.webSearch` (or when the thread tail
 *     references it, so a resumed run keeps the spec of a call it answers);
 *   - `alsoInclude` tools are added even when their pack is not loaded, e.g.
 *     an approval resumed after the user navigated to another page.
 */
import { ADMIN_ONLY_CLIENT_TOOLS, ADMIN_ONLY_PACKS, packsForPage, type ToolPack } from '../contract.js';
import type { AssistantToolDefinition, AssistantToolset, ToolsetOptions } from '../types.js';
import { getDefaultCatalogue } from './catalogue.js';
import { buildToolGuidance } from './guidance.js';

/** Server and client tool names are disjoint, so a name lookup alone gates the admin-only client tools. */
const ADMIN_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(ADMIN_ONLY_CLIENT_TOOLS);

function isAdminOnly(tool: AssistantToolDefinition): boolean {
  if (ADMIN_ONLY_PACKS.includes(tool.pack)) return true;
  return ADMIN_ONLY_TOOL_NAMES.has(tool.name);
}

/** Build a toolset from an explicit catalogue (tests inject one built with fake deps). */
export function selectToolset(catalogue: readonly AssistantToolDefinition[], options: ToolsetOptions): AssistantToolset {
  const packs = packsForPage(options.page.kind, options.isAdmin);
  const extra = new Set(options.alsoInclude);
  const tools = catalogue.filter((tool) => {
    if (!options.isAdmin && isAdminOnly(tool)) return false;
    if (extra.has(tool.name)) return true;
    if (tool.name === 'web_search' && !options.webSearch) return false;
    return packs.includes(tool.pack);
  });
  return toolsetOf(packs, tools);
}

/** The toolset record for an already-selected tool list (also the test fixtures' builder). */
export function toolsetOf(packs: ToolPack[], tools: AssistantToolDefinition[]): AssistantToolset {
  return {
    packs,
    tools,
    byName: new Map(tools.map((tool) => [tool.name, tool])),
    bedrockTools: tools.map((tool) => tool.spec),
  };
}

/** Build the toolset for one run: core + page packs (+ tools referenced by the thread tail). */
export function getAssistantToolset(options: ToolsetOptions): AssistantToolset {
  return selectToolset(getDefaultCatalogue(), options);
}

/**
 * The same toolset without the `project` pack's client (write) tools — for a
 * run whose project on screen the caller can only view. Reads stay, order is
 * preserved (the result is still deterministic for the same input), and the
 * pack list is unchanged so the project read guidance still applies.
 */
export function withoutProjectWrites(toolset: AssistantToolset): AssistantToolset {
  const tools = toolset.tools.filter((tool) => !(tool.kind === 'client' && tool.pack === 'project'));
  if (tools.length === toolset.tools.length) return toolset;
  return toolsetOf(toolset.packs, tools);
}

/**
 * Stable guidance text for the system prompt describing how to use the
 * toolset's packs (which tool for which question, write tools need approval).
 * Deterministic for a given toolset so it can sit inside the cached prefix.
 */
export function toolGuidance(toolset: AssistantToolset): string {
  return buildToolGuidance(toolset);
}
