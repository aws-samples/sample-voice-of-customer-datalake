/**
 * Test support: a synthesized template's `Resources` block, parsed at the boundary (no `as`).
 * Every resource has a `Type`; an absent `Properties` reads as `{}`.
 */
import { z } from 'zod';

export const TemplateResourcesSchema = z.record(z.string(), z.object({
  Type: z.string(),
  Properties: z.record(z.string(), z.unknown()).optional().transform((p) => p ?? {}),
}));
