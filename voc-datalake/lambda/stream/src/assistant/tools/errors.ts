/**
 * Errors raised by assistant tools.
 *
 * A tool failure is not a run failure: the runtime turns a thrown error into an
 * error `toolResult` so the model can tell the user what went wrong (or try a
 * different tool). Every message on an `AssistantToolError` is therefore
 * written FOR THE MODEL — short, English, no internals — and `describeToolError`
 * is the one place that decides what text an arbitrary thrown value may expose.
 */
import { ApiError } from '../../lib/errors.js';

export type ToolErrorCode =
  | 'invalid_input'
  | 'not_permitted'
  | 'not_found'
  | 'too_large'
  | 'not_configured'
  | 'unavailable';

const STATUS_BY_CODE: Record<ToolErrorCode, number> = {
  invalid_input: 400,
  not_permitted: 403,
  not_found: 404,
  too_large: 413,
  not_configured: 500,
  unavailable: 502,
};

/**
 * What a domain route's refusal said beyond its words (internal-api.ts `statusError`): its machine-readable `code`
 * (a snake_case word, `ApiError.code` in lambda/shared/exceptions.py) and, for a workflow save refused because other
 * automations run the flow (7.52.00, `shared_flow`), their names. Never shown as is: the plan step reads them.
 */
export interface ServerRefusal {
  readonly serverCode?: string;
  readonly automations?: readonly string[];
}

export class AssistantToolError extends ApiError {
  readonly code: ToolErrorCode;
  /** The refusal's own `code` (e.g. `shared_flow`), when the route sent one. */
  readonly serverCode: string | undefined;
  /** The automations a `shared_flow` refusal names (its body's `used_by`); none otherwise. */
  readonly automations: readonly string[];

  constructor(code: ToolErrorCode, message: string, refusal: ServerRefusal = {}) {
    super(message, STATUS_BY_CODE[code]);
    this.name = 'AssistantToolError';
    this.code = code;
    this.serverCode = refusal.serverCode;
    this.automations = refusal.automations ?? [];
  }
}

export function isAssistantToolError(err: unknown): err is AssistantToolError {
  return err instanceof AssistantToolError;
}

/**
 * The text a failed tool call hands back to the model.
 *
 * Only `AssistantToolError` messages are trusted verbatim; they are composed in
 * this directory. A 4xx `ApiError` (e.g. the feedback search's validation) is
 * also safe. Anything else — an SDK exception, a bug — is reduced to a generic
 * sentence so stack traces and AWS error text never reach the prompt.
 */
export function describeToolError(err: unknown): string {
  if (isAssistantToolError(err)) return err.message;
  if (err instanceof ApiError && err.statusCode < 500) return err.message;
  return 'The tool failed unexpectedly. Tell the user the data could not be read right now.';
}
