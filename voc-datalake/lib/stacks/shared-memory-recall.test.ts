/**
 * Company knowledge for the SHARED generators (lambda/shared/job_knowledge.py,
 * lib/utils/memory-recall-grant.ts): research, the document generator and the
 * persona generator read voc-memory DIRECTLY — Query + GetItem, UpdateItem for
 * `last_used_at`, never Put or Delete — with KMS decrypt and the Titan embedder,
 * and carry `MEMORY_TABLE`. Agent steps search the web: the nodes Lambda gets
 * the gateway when it is deployed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { apiTemplate } from '../test-support/api-stack-template';
import { allowedActions, roleStatements } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { MEMORY_RECALL_ACTIONS } from '../utils/memory-recall-grant';
import { EMBEDDING_MODEL_ID } from '../utils/model-allowlist';
import { byCodeUnit } from '../utils/compare';

const FunctionSchema = z.object({
  Properties: z.object({
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
    FunctionName: z.unknown(),
  }),
});

/** The function whose physical name contains `baseName`, and its role's logical id. */
function generator(template: Template, baseName: string): { roleId: string; env: Record<string, unknown> } {
  const found = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((resource) => FunctionSchema.safeParse(resource))
    .flatMap((parsed) => (parsed.success ? [parsed.data.Properties] : []))
    .filter((props) => JSON.stringify(props.FunctionName).includes(baseName));
  expect(found, baseName).toHaveLength(1);
  const [props] = found;
  return { roleId: props?.Role['Fn::GetAtt'][0] ?? '', env: props?.Environment.Variables ?? {} };
}

function memoryActions(template: Template, roleId: string): string[] {
  return allowedActions(roleStatements(template, roleId), 'dynamodb:', 'Memory');
}

const RECALL = [...MEMORY_RECALL_ACTIONS].sort(byCodeUnit);

describe('shared generators recall company memories directly', () => {
  const templates: { api?: Template; processing?: Template } = {};
  beforeAll(() => {
    templates.api = apiTemplate();
    templates.processing = synthProcessingTemplate();
  }, SYNTH_TIMEOUT_MS);
  const need = (stack: 'api' | 'processing'): Template => {
    const template = templates[stack];
    if (!template) throw new Error(`${stack} template not synthesized`);
    return template;
  };

  it.each([
    ['api', 'voc-job-document-generator'],
    ['api', 'voc-job-persona-generator'],
    ['processing', 'voc-research-step'],
  ] as const)('%s %s: Query/GetItem/UpdateItem on voc-memory only, MEMORY_TABLE set', (stack, baseName) => {
    const template = need(stack);
    const { roleId, env } = generator(template, baseName);
    expect(memoryActions(template, roleId)).toStrictEqual(RECALL);
    expect(env).toHaveProperty('MEMORY_TABLE');
  });

  it.each([
    ['api', 'voc-job-document-generator'],
    ['processing', 'voc-research-step'],
  ] as const)('%s %s: may embed with the fixed Titan model', (stack, baseName) => {
    const template = need(stack);
    const statements = roleStatements(template, generator(template, baseName).roleId);
    expect(allowedActions(statements, 'bedrock:', EMBEDDING_MODEL_ID)).toStrictEqual(['bedrock:InvokeModel']);
  });

  it('the document merger and persona importer get no memory', () => {
    const template = need('api');
    for (const baseName of ['voc-job-document-merger', 'voc-job-persona-importer']) {
      expect(generator(template, baseName).env).not.toHaveProperty('MEMORY_TABLE');
    }
  });
});
