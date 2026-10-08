/**
 * Unified assistant — internal interfaces between the runtime (handler, loop,
 * AG-UI emitter) and the tool catalogue. The runtime depends only on these
 * types and on `getAssistantToolset()` from `./tools/registry.ts`.
 */
import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import type { BaseEvent } from '@ag-ui/core';
import type { ClientToolName, ForwardedProps, PageContext, ServerToolName, ToolPack } from './contract.js';
import type { ProjectAccessLedger } from './tools/project-access.js';

/**
 * Authorizer claims forwarded verbatim (only these keys) to internal API invokes.
 * Matches the set the project-permissions work forwards (per-project roles are
 * computed by the Projects API from these), so writes and reads made on the
 * user's behalf are authorized exactly as the user's own requests.
 */
export interface CallerClaims {
  sub: string;
  'cognito:groups'?: string;
  'cognito:username'?: string;
  email?: string;
}

/** Feedback card shown under an answer (subset of FeedbackItem). */
export type FeedbackSource = Record<string, unknown> & { feedback_id: string };

export interface WebSourceRef {
  title: string;
  url: string;
}

/** Everything a tool needs about the current run. */
export interface AssistantRunContext {
  claims: CallerClaims;
  isAdmin: boolean;
  page: PageContext;
  props: ForwardedProps;
  /** Resolved model id for the 'chat' surface (consult_personas reuses it). */
  modelId: string | undefined;
  /** Emit an AG-UI event on the open SSE stream (e.g. CUSTOM navigation, STEP_*). */
  emit: (event: BaseEvent) => void;
  /** What the project reads of this run reported about the caller's access (see tools/project-access.ts). */
  projectAccess: ProjectAccessLedger;
}

export interface ServerToolResult {
  /** Text handed back to the model as the toolResult (and as TOOL_CALL_RESULT content). */
  content: string;
  sources?: FeedbackSource[];
  webSources?: WebSourceRef[];
}

export interface ServerToolDefinition {
  kind: 'server';
  name: ServerToolName;
  pack: ToolPack;
  /** Bedrock tool spec (name/description/inputSchema.json). */
  spec: Tool;
  execute(input: unknown, ctx: AssistantRunContext): Promise<ServerToolResult>;
}

export type ClientToolValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

export interface ClientToolDefinition {
  kind: 'client';
  name: ClientToolName;
  pack: ToolPack;
  spec: Tool;
  risk: 'write' | 'destructive';
  /**
   * Validate (and normalise, e.g. fill project_id from the page) the model's
   * arguments. Invalid input is returned to the model as a tool error — no
   * interrupt is raised.
   */
  validate(input: unknown, ctx: AssistantRunContext): ClientToolValidation;
  /** One-line human summary for `Interrupt.message`, in English. */
  summarize(args: Record<string, unknown>): string;
}

export type AssistantToolDefinition = ServerToolDefinition | ClientToolDefinition;

export interface AssistantToolset {
  packs: ToolPack[];
  /** Stable, deterministic order (prompt-cache friendly). */
  tools: AssistantToolDefinition[];
  byName: ReadonlyMap<string, AssistantToolDefinition>;
  /** `tools.map(t => t.spec)` in the same order. */
  bedrockTools: Tool[];
}

export interface ToolsetOptions {
  page: PageContext;
  isAdmin: boolean;
  /** use_web_search requested AND gateway configured. */
  webSearch: boolean;
  /** Tool names referenced by the structured tail of the thread; always included. */
  alsoInclude?: readonly string[];
}
