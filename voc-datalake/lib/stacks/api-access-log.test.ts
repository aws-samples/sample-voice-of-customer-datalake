/**
 * The API stage's access-log format (api-access-log.ts): every field the standard
 * JSON format logged before 5.38 under the same key, plus the four added for error
 * sweeps that exclude e2e traffic (frontend/e2e/README.md → "Test traffic tag").
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

import { ACCESS_LOG_FIELDS } from './api-access-log';
import { byCodeUnit } from '../utils/compare';
import { apiTemplate } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const StageSchema = z.object({
  Properties: z.object({
    StageName: z.string(),
    AccessLogSetting: z.object({ DestinationArn: z.unknown(), Format: z.string() }),
  }),
});

const LogLineSchema = z.record(z.string(), z.string());

/** The stage's access-log Format, parsed as the JSON object it is. */
function stageLogFormat(): Record<string, string> {
  const stages = Object.values(apiTemplate().findResources('AWS::ApiGateway::Stage'))
    .map((resource) => StageSchema.parse(resource).Properties);
  expect(stages).toHaveLength(1);
  const [stage] = stages;
  if (stage === undefined) throw new Error('no API stage in the template');
  return LogLineSchema.parse(JSON.parse(stage.AccessLogSetting.Format));
}

describe('API stage access log', () => {
  it('keeps every field of jsonWithStandardFields() under the same key', () => {
    const standard = LogLineSchema.parse(JSON.parse(apigateway.AccessLogFormat.jsonWithStandardFields().toString()));
    const format = stageLogFormat();
    for (const [key, variable] of Object.entries(standard)) {
      expect(format[key], key).toBe(variable);
    }
    expect(Object.keys(standard).sort(byCodeUnit)).toStrictEqual([
      'caller', 'httpMethod', 'ip', 'protocol', 'requestId', 'requestTime', 'resourcePath', 'responseLength',
      'status', 'user',
    ]);
  });

  it('adds the real path, the user agent, the integration status and the gateway error message', () => {
    const format = stageLogFormat();
    expect(format['path']).toBe('$context.path');
    expect(format['userAgent']).toBe('$context.identity.userAgent');
    expect(format['integrationStatus']).toBe('$context.integration.status');
    expect(format['errorMessage']).toBe('$context.error.message');
  });

  it('logs exactly the declared fields', () => {
    expect(stageLogFormat()).toStrictEqual(ACCESS_LOG_FIELDS);
  });
});
