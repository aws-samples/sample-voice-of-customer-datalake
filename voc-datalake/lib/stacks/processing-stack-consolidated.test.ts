/**
 * Template-level tests for the research Step Functions wiring.
 *
 * Regression guard for issue #157: step_initialize's outputs only reach
 * later steps if InitializeResearch's resultSelector selects them AND the
 * consuming step's payload forwards them. documents_context was silently
 * dropped by the selector, so selected reference documents never reached
 * the analysis prompt. These tests fail if either half of the wiring is
 * removed again (e.g. in a conflict resolution on the selector block).
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { VocProcessingStack } from './processing-stack-consolidated';

function synthProcessingTemplate(): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'TestDeps', { env });

  const makeTable = (id: string, props: Partial<dynamodb.TableProps> = {}) =>
    new dynamodb.Table(deps, id, {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      ...props,
    });

  const stack = new VocProcessingStack(app, 'TestProcessing', {
    env,
    feedbackTable: makeTable('Feedback', { stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES }),
    aggregatesTable: makeTable('Aggregates'),
    projectsTable: makeTable('Projects'),
    jobsTable: makeTable('Jobs'),
    idempotencyTable: makeTable('Idempotency'),
    processingQueue: new sqs.Queue(deps, 'Queue'),
    kmsKey: new kms.Key(deps, 'Key'),
    config: {
      brandName: 'TestBrand',
      brandHandles: ['@testbrand'],
      primaryLanguage: 'en',
      enabledSources: [],
    },
  });

  return Template.fromStack(stack);
}

/** The state machine definition as a searchable string (its DefinitionString
 * is an Fn::Join of JSON fragments and Lambda ARN refs). */
function researchDefinition(template: Template): string {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const ids = Object.keys(machines);
  expect(ids).toHaveLength(1);
  return JSON.stringify(machines[ids[0]].Properties.DefinitionString);
}

describe('research state machine wiring (issue #157)', () => {
  const definition = researchDefinition(synthProcessingTemplate());

  it('selects documents_context out of the initialize result', () => {
    expect(definition).toContain('$.Payload.documents_context');
  });

  it('forwards documents_context into the analyze step payload', () => {
    expect(definition).toContain('$.initialize_result.documents_context');
  });

  it('keeps the sibling context selections intact', () => {
    // The same silent-drop failure mode applies to every initialize output
    // the analyze prompt consumes; pin the full set that must flow.
    for (const key of ['feedback_context', 'feedback_stats', 'personas_context']) {
      expect(definition).toContain(`$.Payload.${key}`);
      expect(definition).toContain(`$.initialize_result.${key}`);
    }
  });
});
