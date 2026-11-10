/**
 * Radar in VocProcessingStack (docs/radar.md): the processor's route to voc-radar and the
 * release-scan worker, voc-radar-scan, whose grants are pinned exactly.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { allowedActions, roleStatements } from '../test-support/iam-statements';
import { findWorkerFunction } from '../test-support/worker-function';

/** The radar schedule's expression and its target's input event. */
const ScheduleSchema = z.object({
  Properties: z.object({ ScheduleExpression: z.string(), Targets: z.tuple([z.object({ Input: z.string() })]) }),
}).transform(({ Properties }) => ({ expression: Properties.ScheduleExpression, input: Properties.Targets[0].Input }));

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

const scanner = () => findWorkerFunction(template, 'voc-radar-scan-');
const scannerStatements = () => roleStatements(template, scanner().Role['Fn::GetAtt'][0]);

describe('the feedback processor', () => {
  it('is told where Radar reviews go and may write only Get/Put/Update there', () => {
    const processor = findWorkerFunction(template, 'voc-feedback-processor');
    expect(JSON.stringify(processor.Environment.Variables.RADAR_TABLE)).toMatch(/Radar/);
    expect(allowedActions(roleStatements(template, processor.Role['Fn::GetAtt'][0]), 'dynamodb:', 'Radar'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
  });
});

describe('voc-radar-scan worker', () => {
  it('runs the scan handler with a 15-minute ceiling and both tables', () => {
    expect(scanner().Handler).toBe('jobs/radar_scan/handler.lambda_handler');
    expect(scanner().Timeout).toBe(900);
    expect(Object.keys(scanner().Environment.Variables)).toStrictEqual(expect.arrayContaining(['RADAR_TABLE', 'AGGREGATES_TABLE']));
  });

  it('holds exactly GetItem/PutItem/Query (+ the version bump) on voc-radar and GetItem on aggregates — never a delete', () => {
    expect(allowedActions(scannerStatements(), 'dynamodb:', 'Radar'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    expect(allowedActions(scannerStatements(), 'dynamodb:', 'Aggregates')).toStrictEqual(['dynamodb:GetItem']);
  });

  it('cannot reach our feedback or any other customer table', () => {
    const offenders = scannerStatements().filter((s) =>
      ['Feedback', 'Projects', 'Memory', 'Agents', 'Conversations'].some((t) => s.resource.includes(t)));
    expect(offenders).toStrictEqual([]);
  });

  it('ticks daily in scheduled mode (the handler decides whether the cadence is due)', () => {
    const schedules = Object.keys(template.findResources('AWS::Events::Rule'))
      .filter((id) => id.startsWith('RadarScanWorkerRadarScanSchedule'))
      .map((id) => ScheduleSchema.parse(template.toJSON().Resources[id]));
    expect(schedules).toStrictEqual([{ expression: 'cron(45 5 * * ? *)', input: JSON.stringify({ mode: 'scheduled' }) }]);
  });
});
