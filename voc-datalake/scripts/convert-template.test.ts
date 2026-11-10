/**
 * scripts/convert-template.mjs turns the synthesized templates into Workshop Studio templates, rewriting the
 * synth's region and account into `${AWS::Region}` / `${AWS::AccountId}`. CloudFormation accepts only a literal
 * string as a template's `Description` ("Every Description member must be a string"), so that rewrite must leave
 * the Description alone: a VocWebSearchStack Description naming its region once came out as an `Fn::Sub` and
 * failed the Workshop Studio build. The script runs `main()` on import, so it runs here in a child process, on a
 * scratch `cdk.out`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const SCRIPT = path.resolve(__dirname, 'convert-template.mjs');
const SectionSchema = z.record(z.string(), z.object({ Description: z.unknown().optional() })).optional();
const ConvertedSchema = z.object({
  Description: z.unknown().optional(),
  Parameters: SectionSchema,
  Outputs: SectionSchema,
  Resources: z.record(z.string(), z.object({ Properties: z.record(z.string(), z.unknown()) })),
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'convert-template-'));
  mkdirSync(path.join(dir, 'cdk.out'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Convert one scratch stack and return its Workshop template. */
function convert(template: Record<string, unknown>): z.infer<typeof ConvertedSchema> {
  writeFileSync(path.join(dir, 'cdk.out', 'Stack.template.json'), JSON.stringify(template));
  writeFileSync(path.join(dir, 'cdk.out', 'Stack.assets.json'), JSON.stringify({ files: {} }));
  execFileSync(process.execPath, [SCRIPT, 'Stack'], { cwd: dir, stdio: 'pipe', encoding: 'utf8', timeout: 30_000 });
  const json: unknown = JSON.parse(readFileSync(path.join(dir, 'Workshop', 'static', 'cfn', 'Stack.json'), 'utf8'));
  return ConvertedSchema.parse(json);
}

const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:queue';
/** A one-resource template, with the given top-level fields. */
const stack = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...fields,
  Parameters: {},
  Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { Arn: QUEUE_ARN } } },
});

describe('convert-template.mjs', () => {
  it('keeps a Description that names the synth region as a literal string', () => {
    const description = 'VoC Data Lake - AI Enablement and us-east-1 resources';
    const converted = convert(stack({ Description: description }));
    expect(converted.Description).toBe(description);
  });

  it('still makes the region and account of resource properties portable', () => {
    const converted = convert(stack({ Description: 'plain' }));
    expect(converted.Resources.Topic?.Properties.Arn).toStrictEqual({ 'Fn::Sub': 'arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:queue' });
  });

  it('leaves a template without a Description without one', () => {
    const converted = convert(stack());
    expect(converted.Description).toBeUndefined();
  });

  it('keeps Parameter and Output Descriptions that name the synth region as literal strings', () => {
    const description = 'Endpoint in us-east-1';
    const converted = convert({
      ...stack(),
      Parameters: { Region: { Type: 'String', Description: description } },
      Outputs: { Url: { Description: description, Value: QUEUE_ARN } },
    });
    expect(converted.Parameters?.Region?.Description).toBe(description);
    expect(converted.Outputs?.Url?.Description).toBe(description);
  });
});
