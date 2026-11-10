/**
 * `argsSchemaFor` for `validatePlan` from a tool catalogue: the strict argument
 * schema each client tool validates with (`tools/client/define.ts`). Pass
 * `getDefaultCatalogue()` in the Lambda, a fake-deps catalogue in tests.
 */
import type { AssistantToolDefinition } from '../types.js';
import type { ArgsSchemaLike } from './validate.js';

export function catalogueArgsSchemaFor(catalogue: readonly AssistantToolDefinition[]): (tool: string) => ArgsSchemaLike | undefined {
  const schemas: ReadonlyMap<string, ArgsSchemaLike> = new Map(catalogue.flatMap((tool) => (tool.kind === 'client' && tool.argsSchema !== undefined ? [[tool.name, tool.argsSchema] as const] : [])));
  return (tool) => schemas.get(tool);
}
