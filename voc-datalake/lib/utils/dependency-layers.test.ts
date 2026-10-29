/**
 * Who gets which Python dependency layer (lib/utils/dependency-layers.ts). The function lists come from
 * scripts/audit/py_layers.py (the gate fails when live code and these lists disagree); this suite pins the
 * synthesized templates to the lists, so the layer cannot quietly reach a function that never signs, or
 * miss one that does.
 */
import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { apiTemplate } from '../test-support/api-stack-template';
import { synthIngestionStacks } from '../test-support/ingestion-stack-fixture';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import {
  EMAIL_INTAKE_LAYER_DIR, SIGNING_LAYER_DIR, SIGNING_LAYER_FUNCTION_IDS, attachSigningLayer,
} from './dependency-layers';

const LayersSchema = z.looseObject({
  Properties: z.looseObject({ Layers: z.array(z.object({ Ref: z.string() })).optional() }),
});
const byName = (a: string, b: string): number => a.localeCompare(b);

/** Logical id of the one layer whose id starts with `prefix`. */
function layerId(template: Template, prefix: string): string {
  const ids = Object.keys(template.findResources('AWS::Lambda::LayerVersion')).filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

/** Logical ids of the functions whose `Layers` name `layer`. */
function functionsWith(template: Template, layer: string): string[] {
  return Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => (LayersSchema.parse(resource).Properties.Layers ?? []).some((ref) => ref.Ref === layer))
    .map(([id]) => id)
    .sort(byName);
}

/** `ProjectsApi16DF3074` -> `ProjectsApi`: the construct id the list names. */
const constructId = (logicalId: string): string => logicalId.replace(/[0-9A-F]{8}$/, '');

describe('the signing layer (cryptography)', () => {
  it('reaches exactly the functions that can sign CloudFront URLs, and nothing else', () => {
    const template = apiTemplate();
    const signing = layerId(template, 'SigningDepsLayer');
    expect(functionsWith(template, signing).map(constructId)).toStrictEqual([...SIGNING_LAYER_FUNCTION_IDS].sort(byName));
  }, SYNTH_TIMEOUT_MS);

  it('those functions keep the shared API layer too', () => {
    const template = apiTemplate();
    const shared = new Set(functionsWith(template, layerId(template, 'ApiDepsLayer')).map(constructId));
    for (const id of SIGNING_LAYER_FUNCTION_IDS) expect(shared.has(id), id).toBe(true);
  }, SYNTH_TIMEOUT_MS);

  it('the processing stack carries no signing layer: none of its functions signs', () => {
    const template = synthProcessingTemplate();
    const ids = Object.keys(template.findResources('AWS::Lambda::LayerVersion'));
    expect(ids.filter((id) => id.startsWith('SigningDepsLayer'))).toStrictEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('throws when a listed function does not exist, so a rename cannot drop the layer silently', () => {
    const stack = new cdk.Stack(new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Bare');
    new lambda.Function(stack, 'ProjectsApi', {
      runtime: lambda.Runtime.PYTHON_3_14, handler: 'h.handler', code: lambda.Code.fromInline('x = 1'),
    });
    expect(() => attachSigningLayer(stack)).toThrow(/has no function 'ProjectsAssistWorker'/);
  });

  it('the split libraries are installed by their own layer and no longer by the shared ones', () => {
    const requirements = (dir: string): string[] => fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8')
      .split('\n').map((line) => line.split('#')[0]?.trim() ?? '').filter(Boolean);
    expect(requirements(SIGNING_LAYER_DIR)).toStrictEqual(['cryptography>=44.0.0']);
    expect(requirements(EMAIL_INTAKE_LAYER_DIR)).toStrictEqual(['lxml>=5.0.0']);
    expect(requirements('lambda/layers/processing-deps').join(' ')).not.toContain('cryptography');
    expect(requirements('lambda/layers/ingestion-deps').join(' ')).not.toContain('lxml');
  });
});

describe('the email-intake layer (lxml)', () => {
  it('exists only with the inbound-email intake, attached only to it', () => {
    const off = synthIngestionStacks().ingestion;
    expect(Object.keys(off.findResources('AWS::Lambda::LayerVersion')).filter((id) => id.startsWith('EmailIntakeDeps')))
      .toStrictEqual([]);
    const on = synthIngestionStacks([], { inboundEmailDomain: 'voc.example.com' }).ingestion;
    const users = functionsWith(on, layerId(on, 'EmailIntakeDepsLayer')).map(constructId);
    expect(users).toStrictEqual(['EmailIntakeFunction']);
  }, SYNTH_TIMEOUT_MS);
});
