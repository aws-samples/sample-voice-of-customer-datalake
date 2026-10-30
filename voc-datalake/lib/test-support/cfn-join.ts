/** Reading synthesized `Fn::Join` strings in stack tests. */
import { z } from 'zod';

const RefJoinSchema = z.object({
  'Fn::Join': z.tuple([z.literal(''), z.array(z.union([z.string(), z.object({ Ref: z.string() })]))]),
});

/**
 * A synthesized string value as one string: a literal as-is, an `Fn::Join` of
 * literals and `{Ref}`s with each Ref written out as `${Ref}`. Anything else throws.
 */
export function flattenRefJoin(value: unknown): string {
  if (typeof value === 'string') return value;
  return RefJoinSchema.parse(value)['Fn::Join'][1]
    .map((part) => (typeof part === 'string' ? part : `\${${part.Ref}}`))
    .join('');
}
