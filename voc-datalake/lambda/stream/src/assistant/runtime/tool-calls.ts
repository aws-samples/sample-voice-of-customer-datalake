/**
 * Execute the tool calls of one assistant turn.
 *
 * Server tools are independent reads, so they run CONCURRENTLY (bounded by
 * MAX_PARALLEL_SERVER_TOOLS): each one's START/ARGS/END goes out in call order
 * up front, and once all have settled every call is answered in call order —
 * so the toolResult blocks line up with Bedrock's toolUse blocks, and a client
 * write is validated against every project read of the same turn.
 *
 *   unknown tool         → error toolResult
 *   server tool          → START/ARGS/END, execute(), TOOL_CALL_RESULT; a thrown
 *                          error becomes an error toolResult (the run goes on)
 *   client tool, invalid → START/ARGS(raw)/END + error TOOL_CALL_RESULT; no interrupt
 *   project write on a project the caller can only view (per this run's
 *   project reads) → same as invalid: error result, no approval card
 *   client tool, valid   → START/ARGS(normalised)/END; remembered as a pending
 *                          approval — the SPA answers it after the interrupt
 *
 * Every call is emitted, including failures, so the SPA's copy of the thread
 * pairs each tool call with a result exactly as Bedrock saw it, and a resumed
 * run can be rebuilt from it.
 *
 * Logs carry tool names and outcome kinds only — never inputs or results.
 */
import { randomUUID } from 'node:crypto';
import type { ContentBlock, ToolResultStatus } from '@aws-sdk/client-bedrock-runtime';
import { ADMIN_ONLY_CLIENT_TOOLS, type ClientToolName } from '../contract.js';
import type {
  AssistantRunContext,
  AssistantToolset,
  ClientToolDefinition,
  FeedbackSource,
  ServerToolDefinition,
  ServerToolResult,
  WebSourceRef,
} from '../types.js';
import type { ToolUseBlock } from '../../bedrock/stream-processor.js';
import { isApiError } from '../../lib/errors.js';
import { describeToolError, isAssistantToolError } from '../tools/errors.js';
import { emitToolCall, events, type Emitter } from './emitter.js';

export interface PendingApproval {
  toolCallId: string;
  tool: ClientToolDefinition;
  args: Record<string, unknown>;
}

export interface ToolRoundResult {
  /** One toolResult block per call, in call order (for the next user message). */
  results: ContentBlock[];
  pending: PendingApproval[];
  sources: FeedbackSource[];
  webSources: WebSourceRef[];
}

const ERROR_STATUS: ToolResultStatus = 'error';

function isAdminOnlyClientTool(name: ClientToolName): boolean {
  return ADMIN_ONLY_CLIENT_TOOLS.includes(name);
}

/**
 * The model-facing text for a thrown server-tool error. `describeToolError` is
 * the one place that decides what an arbitrary thrown value may expose (tool
 * errors verbatim, 4xx API messages, a generic sentence for anything else).
 * A 403 that did not come from the tool layer — whose `not_permitted` messages
 * already say so — is additionally named as a permission problem.
 */
function toolErrorText(err: unknown): string {
  const text = describeToolError(err);
  if (!isAssistantToolError(err) && isApiError(err) && err.statusCode === 403) {
    return `Error: the user does not have permission for this. ${text}`;
  }
  return `Error: ${text}`;
}

/** The one Bedrock toolResult block builder (live tool rounds and the resumed tail). */
export function toolResultBlock(toolUseId: string, text: string, isError: boolean): ContentBlock {
  return {
    toolResult: {
      toolUseId,
      content: [{ text }],
      ...(isError ? { status: ERROR_STATUS } : {}),
    },
  };
}

interface CallContext {
  emitter: Emitter;
  ctx: AssistantRunContext;
  parentMessageId: string;
  round: ToolRoundResult;
}

function emitCall(call: ToolUseBlock, c: CallContext, argsJson: string): void {
  emitToolCall(c.emitter, { toolCallId: call.toolUseId, name: call.name, parentMessageId: c.parentMessageId, argsJson });
}

/** Emit TOOL_CALL_RESULT and record the matching Bedrock toolResult. */
function respond(call: ToolUseBlock, c: CallContext, text: string, isError: boolean): void {
  const content = text || '(empty result)';
  c.emitter.emit(events.toolResult(randomUUID(), call.toolUseId, content));
  c.round.results.push(toolResultBlock(call.toolUseId, content, isError));
}

/** A call that is answered without running anything (all error paths). */
function settle(call: ToolUseBlock, c: CallContext, text: string): void {
  emitCall(call, c, JSON.stringify(call.input));
  respond(call, c, text, true);
}

/**
 * Server tools of one turn that may execute at once. They are independent reads
 * (each an internal API invoke, Bedrock call or web search), so a turn that asks
 * for several waits for the slowest instead of their sum; the cap bounds the
 * extra load one user's turn puts on the domain APIs.
 */
export const MAX_PARALLEL_SERVER_TOOLS = 4;

type ServerOutcome = { ok: true; result: ServerToolResult } | { ok: false; err: unknown };

/** Run `tasks` with at most `limit` in flight. */
async function runBounded(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  const queue = [...tasks];
  async function worker(): Promise<void> {
    const task = queue.shift();
    if (task === undefined) return;
    await task();
    await worker();
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

async function executeServerTool(call: ToolUseBlock, tool: ServerToolDefinition, c: CallContext): Promise<ServerOutcome> {
  try {
    return { ok: true, result: await tool.execute(call.input, c.ctx) };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * Emit every server call (in call order) and execute them concurrently, bounded.
 * Resolves once all have settled: one outcome per server call, at its CALL index.
 */
async function executeServerTools(
  calls: readonly ToolUseBlock[], toolset: AssistantToolset, c: CallContext,
): Promise<Map<number, ServerOutcome>> {
  const outcomes = new Map<number, ServerOutcome>();
  const tasks: (() => Promise<void>)[] = [];
  for (const [index, call] of calls.entries()) {
    const tool = toolset.byName.get(call.name);
    if (tool?.kind !== 'server') continue;
    emitCall(call, c, JSON.stringify(call.input));
    tasks.push(async () => {
      outcomes.set(index, await executeServerTool(call, tool, c));
    });
  }
  await runBounded(tasks, MAX_PARALLEL_SERVER_TOOLS);
  return outcomes;
}

/** Answer one executed server call: TOOL_CALL_RESULT, its toolResult block, its sources. */
function settleServerTool(call: ToolUseBlock, outcome: ServerOutcome, c: CallContext): void {
  if (outcome.ok) {
    respond(call, c, outcome.result.content, false);
    c.round.sources.push(...(outcome.result.sources ?? []));
    c.round.webSources.push(...(outcome.result.webSources ?? []));
    return;
  }
  const errorKind = outcome.err instanceof Error ? outcome.err.name : 'unknown';
  console.warn(`Server tool ${call.name} failed (${errorKind}); returning an error result to the model`);
  respond(call, c, toolErrorText(outcome.err), true);
}

/**
 * A project write aimed at a project whose read reported `can_edit: false`.
 * Checked on the VALIDATED args, so a `project_id` filled from the page counts.
 */
function readOnlyProjectTarget(tool: ClientToolDefinition, args: Record<string, unknown>, ctx: AssistantRunContext): string | undefined {
  if (tool.pack !== 'project') return undefined;
  const projectId = args.project_id;
  return typeof projectId === 'string' && ctx.projectAccess.isReadOnly(projectId) ? projectId : undefined;
}

function runClientTool(call: ToolUseBlock, tool: ClientToolDefinition, c: CallContext): void {
  if (isAdminOnlyClientTool(tool.name) && !c.ctx.isAdmin) {
    settle(call, c, 'Error: this action requires an administrator.');
    return;
  }
  const validation = tool.validate(call.input, c.ctx);
  if (!validation.ok) {
    console.warn(`Client tool ${call.name}: invalid arguments; returning an error result to the model`);
    settle(call, c, `Error: invalid arguments — ${validation.error}`);
    return;
  }
  const readOnly = readOnlyProjectTarget(tool, validation.args, c.ctx);
  if (readOnly !== undefined) {
    console.warn(`Client tool ${call.name}: project is view-only for the caller; refused`);
    settle(call, c, `Error: not permitted — the signed-in user can only view project ${readOnly}, so it cannot be `
      + 'changed. Do not propose changes to it; the project owner can grant edit access.');
    return;
  }
  emitCall(call, c, JSON.stringify(validation.args));
  c.round.pending.push({ toolCallId: call.toolUseId, tool, args: validation.args });
}

export async function runToolCalls(
  calls: readonly ToolUseBlock[],
  toolset: AssistantToolset,
  ctx: AssistantRunContext,
  emitter: Emitter,
  parentMessageId: string,
): Promise<ToolRoundResult> {
  const round: ToolRoundResult = { results: [], pending: [], sources: [], webSources: [] };
  const c: CallContext = { emitter, ctx, parentMessageId, round };
  // Server tools first, together: every server read of this turn has recorded
  // its project access before any client write of the same turn is validated.
  const serverOutcomes = await executeServerTools(calls, toolset, c);
  // Then every call is answered in CALL order, so the toolResult blocks (and
  // sources) line up with the toolUse blocks exactly as Bedrock requires.
  for (const [index, call] of calls.entries()) {
    const tool = toolset.byName.get(call.name);
    if (!tool) {
      console.warn(`Model called unknown tool ${call.name.slice(0, 64)}`);
      settle(call, c, `Error: unknown tool "${call.name}".`);
    } else if (tool.kind === 'server') {
      // Every server call has an outcome (executeServerTools awaited them all).
      settleServerTool(call, serverOutcomes.get(index) ?? { ok: false, err: undefined }, c);
    } else {
      runClientTool(call, tool, c);
    }
  }
  return round;
}
