/**
 * The review registries' backfill marker is deleted when the release gains or loses the resource that holds it
 * (review-registries-marker.ts, in VocCoreStack, 7.48.00, projects 3g-d), by a policy that may delete in
 * `DOCSHARE_IDS` only; and the functions that run the projects handler, the one entry that writes review links,
 * comment threads and projects (every API bundle ships `shared/`, so the entry, not the files, tells a writer), are
 * exactly the two the backfill waits for (scripts/projects/backfill_review_registries.py `WRITER_NAMES`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiTemplate } from '../test-support/api-stack-template';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { IamPolicySchema } from '../test-support/iam-statements';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import {
  REVIEW_REGISTRIES_MARKER_PK, REVIEW_REGISTRIES_MARKER_RESET_TYPE, REVIEW_REGISTRIES_MARKER_SK,
} from './review-registries-marker';

const ResetSchema = z.object({
  Properties: z.object({ Create: z.unknown(), Delete: z.unknown(), Update: z.unknown().optional() }),
});
const FunctionSchema = z.object({
  Properties: z.object({ Handler: z.string().optional(), FunctionName: z.unknown().optional() }),
});

const repoFile = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', ...parts), 'utf-8');

let core: Template;
beforeAll(() => {
  core = synthCoreTemplate();
  apiTemplate();
}, SYNTH_TIMEOUT_MS * 2);

function resets(): z.infer<typeof ResetSchema>[] {
  return Object.values(core.findResources(REVIEW_REGISTRIES_MARKER_RESET_TYPE))
    .map((resource) => ResetSchema.parse(resource));
}

describe('the review registries marker reset', () => {
  it('is one resource of the core stack, none of the API stack, and does nothing on update', () => {
    const found = resets();
    expect(found).toHaveLength(1);
    expect(found[0]?.Properties.Update).toBeUndefined();
    expect(apiTemplate().findResources(REVIEW_REGISTRIES_MARKER_RESET_TYPE)).toStrictEqual({});
  });

  it('is the stack\'s only AwsCustomResource, so CDK\'s shared provider role holds its policy alone', () => {
    // Every AwsCustomResource of a stack runs on one singleton provider (AWS679f53fac002430cb0da5b7982bd2287) and its
    // one role; another one here would share this role and its DeleteItem.
    const resources = z.object({ Resources: z.record(z.string(), z.unknown()) }).parse(core.toJSON()).Resources;
    const onProvider = Object.values(resources)
      .filter((resource) => JSON.stringify(resource).includes('AWS679f53fac002430cb0da5b7982bd2287'))
      .map((resource) => z.object({ Type: z.string() }).parse(resource).Type)
      .filter((type) => type.startsWith('Custom::'));
    expect(onProvider).toStrictEqual([REVIEW_REGISTRIES_MARKER_RESET_TYPE]);
  });

  it.each(['Create', 'Delete'] as const)('deletes exactly the marker on %s', (event) => {
    const text = JSON.stringify(resets()[0]?.Properties[event]);
    expect(text).toContain('deleteItem');
    expect(text).toContain(`\\"pk\\":{\\"S\\":\\"${REVIEW_REGISTRIES_MARKER_PK}\\"}`);
    expect(text).toContain(`\\"sk\\":{\\"S\\":\\"${REVIEW_REGISTRIES_MARKER_SK}\\"}`);
  });

  it('names the marker the Python stores name', () => {
    const keys = repoFile('lambda', 'shared', 'project_keys.py');
    expect(keys).toContain(`DEPLOYMENT_LINK_REGISTRY_PK: Final = _REVIEW_LINK_REGISTRY`);
    expect(keys).toContain(`_REVIEW_LINK_REGISTRY: Final = '${REVIEW_REGISTRIES_MARKER_PK}'`);
    expect(keys).toContain(`REVIEW_REGISTRIES_MARKER_SK: Final = '${REVIEW_REGISTRIES_MARKER_SK}'`);
  });

  it('may delete in DOCSHARE_IDS only (IAM cannot pin the sort key) and decrypt with the table key', () => {
    const policies = Object.entries(core.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('ReviewRegistriesMarkerReset'))
      .map(([, resource]) => IamPolicySchema.parse(resource).Properties);
    expect(policies).toHaveLength(1);
    const statements = policies[0]?.PolicyDocument.Statement ?? [];
    // The DeleteItem, the key's Decrypt, and the audit-row guard's Deny.
    expect(statements.map((statement) => [statement.Effect, statement.Action])).toStrictEqual([
      ['Allow', 'dynamodb:DeleteItem'], ['Allow', 'kms:Decrypt'],
      ['Deny', ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']]]);
    expect(JSON.stringify(statements[0])).toContain(JSON.stringify({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [REVIEW_REGISTRIES_MARKER_PK] },
    }));
    expect(JSON.stringify(statements[0]?.Resource)).not.toContain('/index/');
  });
});

describe('the writers the backfill waits for', () => {
  it('are exactly the functions that run the projects handler', () => {
    const named = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((resource) => FunctionSchema.parse(resource).Properties)
      .filter((properties) => properties.Handler === 'projects_handler.lambda_handler')
      .map((properties) => JSON.stringify(properties.FunctionName));
    const source = repoFile('scripts', 'projects', 'backfill_review_registries.py');
    const listed = /WRITER_NAMES = \(([^)]*)\)/.exec(source)?.[1] ?? '';
    const bases = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
    expect(bases).toStrictEqual(['voc-projects-api', 'voc-projects-assist']);
    expect(named).toHaveLength(bases.length);
    for (const base of bases) {
      expect(named.filter((name) => name.includes(base))).toHaveLength(1);
    }
  });
});
