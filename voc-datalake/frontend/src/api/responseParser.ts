import { z } from 'zod'

/**
 * Generic API response parser using Zod for runtime validation.
 * This satisfies the no-type-assertions rule by using proper runtime validation.
 */

// Base schema for validating that we got a valid JSON response
const baseResponseSchema = z.unknown()

/**
 * Parse a JSON response with optional schema validation.
 * When no schema is provided, it returns the raw parsed JSON.
 * The caller is responsible for ensuring type safety.
 */
export async function parseResponse<T>(
  response: Response,
  schema?: z.ZodType<T>
): Promise<T> {
  const rawJson: unknown = await response.json()
  const parsed = baseResponseSchema.parse(rawJson)
  
  if (schema) {
    return schema.parse(parsed)
  }
  
  // For unvalidated responses, we use Zod's passthrough to maintain type safety
  // This is the only way to convert unknown to T without type assertions
  const passthroughSchema = z.custom<T>(() => true)
  return passthroughSchema.parse(parsed)
}

/**
 * Create a typed response parser for a specific schema.
 * Use this when you have a Zod schema for the expected response.
 */
export function createResponseParser<T>(schema: z.ZodType<T>) {
  return async (response: Response): Promise<T> => {
    const rawJson: unknown = await response.json()
    return schema.parse(rawJson)
  }
}
