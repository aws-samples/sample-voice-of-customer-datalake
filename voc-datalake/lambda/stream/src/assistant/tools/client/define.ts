/**
 * Factory for client (write) tool definitions.
 *
 * The server never executes these. `validate()` checks and normalises the
 * model's arguments (strict: unknown keys are refused), fills `project_id` from
 * the page when the tool is project-scoped and the model omitted it, and
 * refuses admin-only tools for non-admins. The normalised args are what the
 * approval card shows and what the SPA executes.
 */
import { z } from 'zod';
import {
  ADMIN_ONLY_CLIENT_TOOLS,
  DESTRUCTIVE_CLIENT_TOOLS,
  type ClientToolName,
  type PageContext,
  type ToolPack,
} from '../../contract.js';
import type { ClientToolDefinition, ClientToolValidation } from '../../types.js';
import { clip, isRecord } from '../format.js';
import { describeIssues, idSchema, toolSpec, type JsonSchemaProperties } from '../spec.js';

const APPROVAL_NOTE = ' Requires the user\u2019s approval: the user sees exactly these arguments in an approval '
  + 'card and nothing changes unless they approve. Never say the change was made unless the tool result has '
  + 'status "executed".';

type ArgsSchema<T> = z.ZodType<T, unknown>;

export interface ClientToolConfig<T extends Record<string, unknown>> {
  name: ClientToolName;
  pack: ToolPack;
  description: string;
  properties: JsonSchemaProperties;
  required: readonly string[];
  schema: ArgsSchema<T>;
  /** Fill a missing `project_id` from `ctx.page.projectId`. */
  projectScoped?: boolean;
  /** Fill a missing `feedback_id` from `ctx.page.feedbackId` (the item on screen). */
  feedbackScoped?: boolean;
  /** Fill a missing `agent_id` from `ctx.page.agentId` (the agent on screen). */
  agentScoped?: boolean;
  summarize(args: T): string;
}

/** Tool id argument → the page field that defaults it, per scoping flag. */
const PAGE_DEFAULTS = [
  { flag: 'projectScoped', arg: 'project_id', field: 'projectId' },
  { flag: 'feedbackScoped', arg: 'feedback_id', field: 'feedbackId' },
  { flag: 'agentScoped', arg: 'agent_id', field: 'agentId' },
] as const;

type ScopingFlags = Pick<ClientToolConfig<Record<string, unknown>>, (typeof PAGE_DEFAULTS)[number]['flag']>;

/** The model's arguments with page defaults filled in for the ids it omitted. */
function withPageDefaults(input: Record<string, unknown>, config: ScopingFlags, page: PageContext): Record<string, unknown> {
  const filled = { ...input };
  for (const { flag, arg, field } of PAGE_DEFAULTS) {
    if (config[flag] === true && filled[arg] === undefined && page[field] !== undefined) filled[arg] = page[field];
  }
  return filled;
}

/** Quote a user-visible value for a one-line summary. */
export function q(value: string, max = 80): string {
  return `'${clip(value.replaceAll(/\s+/g, ' ').trim(), max)}'`;
}

export function defineClientTool<T extends Record<string, unknown>>(config: ClientToolConfig<T>): ClientToolDefinition {
  const adminOnly = ADMIN_ONLY_CLIENT_TOOLS.includes(config.name);
  return {
    kind: 'client',
    name: config.name,
    pack: config.pack,
    risk: DESTRUCTIVE_CLIENT_TOOLS.includes(config.name) ? 'destructive' : 'write',
    spec: toolSpec(config.name, config.description + APPROVAL_NOTE, config.properties, config.required),
    validate(input, ctx): ClientToolValidation {
      if (adminOnly && !ctx.isAdmin) {
        return { ok: false, error: `${config.name} is only available to administrators.` };
      }
      if (!isRecord(input)) return { ok: false, error: 'Arguments must be a JSON object.' };
      const parsed = config.schema.safeParse(withPageDefaults(input, config, ctx.page));
      if (!parsed.success) return { ok: false, error: `Invalid arguments — ${describeIssues(parsed.error)}` };
      return { ok: true, args: parsed.data };
    },
    summarize(args) {
      const parsed = config.schema.safeParse(args);
      return parsed.success ? config.summarize(parsed.data) : `Run ${config.name}.`;
    },
  };
}

// ── Shared argument schemas ──

/** A calendar date argument (`YYYY-MM-DD`). */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

/** "a, b" of the parts that are present — for summaries of optional-field writes. */
export function presentParts(parts: readonly (string | false)[]): string {
  return parts.filter(Boolean).join(', ');
}

export const idListSchema = (max: number) => z.array(idSchema).max(max);

export function stringProperty(description: string, maxLength?: number): JsonSchemaProperties[string] {
  return maxLength === undefined ? { type: 'string', description } : { type: 'string', maxLength, description };
}

export function idListProperty(description: string, maxItems: number): JsonSchemaProperties[string] {
  return { type: 'array', items: { type: 'string' }, maxItems, description };
}
