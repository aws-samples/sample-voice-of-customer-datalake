/**
 * Bedrock tool-spec construction and model-input parsing shared by every tool.
 */
import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import { z } from 'zod';
import { AssistantToolError } from './errors.js';

export type JsonSchemaProperties = Record<string, DocumentType>;

/** A Bedrock tool spec with an object input schema. */
export function toolSpec(
  name: string,
  description: string,
  properties: JsonSchemaProperties,
  required: readonly string[] = [],
): Tool {
  return {
    toolSpec: {
      name,
      description,
      inputSchema: {
        json: {
          type: 'object',
          properties,
          required: [...required],
          additionalProperties: false,
        },
      },
    },
  };
}

/** Ids reach URL paths and DynamoDB keys downstream: a conservative charset. */
const ID_PATTERN = /^[\w.:-]+$/;
const MAX_TOOL_ID_LENGTH = 128;

export const idSchema = z.string().trim().min(1).max(MAX_TOOL_ID_LENGTH).regex(ID_PATTERN, 'must be a plain identifier');

/** JSON-schema fragment for an id argument. */
export function idProperty(description: string): DocumentType {
  return { type: 'string', maxLength: MAX_TOOL_ID_LENGTH, description };
}

/** One readable line describing every zod issue. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/** Parse model input or throw an `invalid_input` tool error the model can act on. */
export function parseToolInput<T>(schema: z.ZodType<T, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AssistantToolError('invalid_input', `Invalid arguments — ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** The explicit id, else the page default, else an error naming the argument. */
export function resolveId(explicit: string | undefined, pageDefault: string | undefined, argName: string): string {
  const value = explicit ?? pageDefault;
  if (value === undefined) {
    throw new AssistantToolError('invalid_input', `Missing ${argName}: none was given and the current page has no default.`);
  }
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AssistantToolError('invalid_input', `Invalid ${argName}.`);
  return parsed.data;
}
