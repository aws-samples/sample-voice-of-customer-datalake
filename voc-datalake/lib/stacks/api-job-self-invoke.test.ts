/**
 * The four async job Lambdas' self-invoke grant (api-job-lambdas.ts).
 *
 * A job delivery that loses the execution lease requeues itself before its own
 * budget runs out (lambda/shared/jobs.py `recover_job_execution_claim` invokes
 * its own `invoked_function_arn`). The grant must name the function in the
 * colon form Lambda uses (`function:<name>`): the slash form matches no
 * function, so IAM denied every requeue.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiTemplate } from '../test-support/api-stack-template';
import { flattenRefJoin } from '../test-support/cfn-join';
import { roleStatements } from '../test-support/iam-statements';
import { SYNTH_ACCOUNT, SYNTH_REGION, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const JOB_BASE_NAMES = [
  'voc-job-persona-generator',
  'voc-job-document-generator',
  'voc-job-document-merger',
  'voc-job-persona-importer',
] as const;

const ResourceListSchema = z.union([z.unknown().array(), z.unknown()]);
const JobFunctionSchema = z.object({
  Properties: z.object({
    FunctionName: z.unknown(),
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) }),
  }),
});

/** Every resource the role may `lambda:InvokeFunction`, flattened to plain ARN strings. */
function invokeTargets(template: Template, roleLogicalId: string): string[] {
  return roleStatements(template, roleLogicalId)
    .filter((statement) => statement.actions.includes('lambda:InvokeFunction'))
    .flatMap((statement) => {
      const parsed = ResourceListSchema.parse(JSON.parse(statement.resource));
      return (Array.isArray(parsed) ? parsed : [parsed]).map(flattenRefJoin);
    });
}

describe('VocApiStack job Lambda self-invoke grants', () => {
  let template: Template;
  beforeAll(() => {
    template = apiTemplate();
  }, SYNTH_TIMEOUT_MS);

  const jobFunction = (baseName: string) => {
    const matches = Object.values(template.findResources('AWS::Lambda::Function'))
      .flatMap((resource) => {
        const parsed = JobFunctionSchema.safeParse(resource);
        if (!parsed.success) return [];
        const name = flattenRefJoin(parsed.data.Properties.FunctionName);
        return name.startsWith(`${baseName}-`) ? [{ name, roleId: parsed.data.Properties.Role['Fn::GetAtt'][0] }] : [];
      });
    expect(matches, `exactly one ${baseName} function`).toHaveLength(1);
    const [only] = matches;
    if (!only) throw new Error(`no ${baseName} function`);
    return only;
  };

  it.each(JOB_BASE_NAMES)('lets %s invoke its own function by colon-form ARN', (baseName) => {
    const { name, roleId } = jobFunction(baseName);
    const own = invokeTargets(template, roleId).filter((arn) => arn.endsWith(`:function:${name}`));
    expect(own).toStrictEqual([`arn:\${AWS::Partition}:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:function:${name}`]);
  });

  it.each(JOB_BASE_NAMES)('gives %s no slash-form function ARN', (baseName) => {
    const { roleId } = jobFunction(baseName);
    expect(invokeTargets(template, roleId).filter((arn) => arn.includes(':function/'))).toStrictEqual([]);
  });
});
