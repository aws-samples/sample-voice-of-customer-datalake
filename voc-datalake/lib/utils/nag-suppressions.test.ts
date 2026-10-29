/**
 * Every `{ regex }` `appliesTo` in nag-suppressions.ts means what its reason says.
 *
 * The trap this pins: a backslash in a single-quoted TS string is dropped (`'\.Arn>/\*'` is the text
 * `.Arn>/*`), so `\.` became "any character" and `/\*` became "zero or more slashes", and every regex
 * suppressed far more than it named (`<Bucket.Arn>/*` also swallowed every `<Bucket.Arn>/<prefix>/*`
 * grant, and `.Arn>:*` matched the bare ARN). Each regex must compile the way cdk-nag compiles it
 * (`NagSuppressionHelper.toRegEx`), be anchored, escape every literal `.` before `Arn>` / `Name>` and every
 * literal `*`, and accept / refuse the findings below.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as suppressionModule from './nag-suppressions';

const RegexItemSchema = z.object({ regex: z.string() });
const SuppressionSchema = z.object({ id: z.string(), appliesTo: z.array(z.unknown()).optional() });

/** Every regex string declared in the module: the exported lists plus the one list builder. */
function declaredRegexes(): string[] {
  const lists: unknown[] = [...suppressionModule.pluginSystemSuppressions()];
  for (const value of Object.values(suppressionModule)) {
    if (Array.isArray(value)) lists.push(...value);
  }
  return lists.flatMap((entry) => {
    const appliesTo = SuppressionSchema.parse(entry).appliesTo ?? [];
    return appliesTo.flatMap((item) => {
      const parsed = RegexItemSchema.safeParse(item);
      return parsed.success ? [parsed.data.regex] : [];
    });
  });
}

/** cdk-nag's own parse (`toRegEx`): `/<source>/<flags>`, the source ending at the LAST slash. */
function compile(regex: string): RegExp {
  const first = regex.indexOf('/');
  const last = regex.lastIndexOf('/');
  if (first < 0 || last <= first) throw new Error(`not a /source/flags regex: ${regex}`);
  return new RegExp(regex.slice(first + 1, last), regex.slice(last + 1));
}

const regexes = declaredRegexes();
const matchesAny = (findingId: string) => regexes.some((r) => compile(r).test(findingId));

describe('nag-suppressions.ts appliesTo regexes', () => {
  it('declares regexes (vacuity guard)', () => {
    expect(regexes.length).toBeGreaterThan(20);
  });

  it.each(regexes)('%s compiles, is anchored and escapes its literals', (regex) => {
    const source = compile(regex).source;
    expect(source.startsWith('^')).toBe(true);
    expect(source.endsWith('$')).toBe(true);
    // A literal `.` before a CloudFormation attribute must be escaped.
    expect(source).not.toMatch(/(^|[^\\])\.(Arn|Name)>/);
    // Every `*` is either the `.*` quantifier or an escaped literal `\*`.
    expect(source).not.toMatch(/(^|[^.\\])\*/);
  });

  it.each([
    'Resource::<FeedbackTableF528636C.Arn>/index/*',
    'Resource::<ResearchStepLambdaDB89028D.Arn>:*',
    'Resource::<RawDataBucket57F26C03.Arn>/*',
    'Resource::<RawDataBucket57F26C03.Arn>/raw/*',
    'Resource::<RawDataBucket57F26C03.Arn>/avatars/*',
    'Resource::<RawDataBucket57F26C03.Arn>/projects/*/product_docs/extracted/*',
    'Resource::<RawDataBucket57F26C03.Arn>/scratch/research_jobs/*',
    'Resource::<WebsiteBucket75C24D94.Arn>/*',
    'Resource::arn:aws:s3:::cdk-hnb659fds-assets-111111111111-us-east-1/*',
  ])('suppresses the finding it names: %s', (findingId) => {
    expect(matchesAny(findingId)).toBe(true);
  });

  it.each([
    // The unescaped forms matched all of these.
    'Resource::<FeedbackTableF528636C.Arn>/index',
    'Resource::<FeedbackTableF528636CxArn>/index/*',
    'Resource::<ResearchStepLambdaDB89028D.Arn>',
    'Resource::<RawDataBucket57F26C03.Arn>/new-prefix/*',
    'Resource::<RawDataBucket57F26C03.Arn>/raw/other_source/*',
    'Resource::<WebsiteBucket75C24D94.Arn>/assets/*',
    'Resource::<S3ImportBucket676867E6.Arn>',
    'Resource::arn:aws:s3:::cdk-hnb659fds-assets-111111111111-us-east-1/extra/*',
  ])('does not suppress a finding no reason covers: %s', (findingId) => {
    expect(matchesAny(findingId)).toBe(false);
  });
});
