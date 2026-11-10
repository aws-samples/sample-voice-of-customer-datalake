/**
 * Render a synthesized CloudFormation string value (a literal, `Fn::Join`, `Ref`, `Fn::GetAtt`) as one
 * readable string, so a test can pin a value that embeds a token: `{Ref:X}`, `{GetAtt:X.Y}` stand in
 * for what CloudFormation resolves at deploy time.
 */
import { z } from 'zod';

const JoinSchema = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) });
const RefSchema = z.object({ Ref: z.string() });
const GetAttSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) });

export function renderCfnString(value: unknown): string {
  if (typeof value === 'string') return value;
  const join = JoinSchema.safeParse(value);
  if (join.success) {
    const [separator, parts] = join.data['Fn::Join'];
    return parts.map(renderCfnString).join(separator);
  }
  const ref = RefSchema.safeParse(value);
  if (ref.success) return `{Ref:${ref.data.Ref}}`;
  const getAtt = GetAttSchema.safeParse(value);
  if (getAtt.success) return `{GetAtt:${getAtt.data['Fn::GetAtt'].join('.')}}`;
  return `{${JSON.stringify(value)}}`;
}

/** A CloudFormation string map (e.g. a gateway response's ResponseParameters), each value rendered. */
export const RenderedStringRecordSchema = z.record(z.string(), z.unknown()).transform((params) =>
  Object.fromEntries(Object.entries(params).map(([key, value]) => [key, renderCfnString(value)])));
