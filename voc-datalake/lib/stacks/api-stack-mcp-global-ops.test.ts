/**
 * Operations of the global MCP endpoint (docs/mcp.md → Alarms and concurrency): its reserved
 * concurrency, and the logs API knowing the endpoint's Powertools service, the dimension the
 * runtime MCP alarms filter on (lambda/shared/ops_alerts.py MCP_ALARMS).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { apiTemplate, functionIdForHandler, serviceEnvironment, synthApiTemplate } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { GLOBAL_MCP_SERVICE_NAME } from '../utils/function-names';
import type { Template } from 'aws-cdk-lib/assertions';
import { nonNegativeIntegerContext } from '../utils/context-flag';
import { GLOBAL_MCP_RESERVED_CONCURRENCY } from './global-mcp';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

/** A template resource's `Properties`, or undefined when it has none. */
function propertiesOf(resource: unknown): Record<string, unknown> | undefined {
  if (typeof resource !== 'object' || resource === null || !('Properties' in resource)) return undefined;
  const { Properties: properties } = resource;
  return typeof properties === 'object' && properties !== null ? { ...properties } : undefined;
}

function mcpFunctionProperties(template: Template = apiTemplate()): Record<string, unknown> {
  const id = functionIdForHandler(template, 'mcp_global_handler.py');
  const properties = propertiesOf(template.toJSON().Resources?.[id]);
  expect(properties, id).toBeDefined();
  return properties ?? {};
}

describe('global MCP endpoint operations', () => {
  it('reserves exactly the named concurrency for the endpoint function', () => {
    expect(GLOBAL_MCP_RESERVED_CONCURRENCY).toBe(20);
    expect(mcpFunctionProperties().ReservedConcurrentExecutions).toBe(GLOBAL_MCP_RESERVED_CONCURRENCY);
  });

  it('takes -c mcpReservedConcurrency: another number, or 0 for no reservation at all (never a throttling 0)', () => {
    expect(mcpFunctionProperties(synthApiTemplate({ mcpReservedConcurrency: '35' })).ReservedConcurrentExecutions).toBe(35);
    const none = synthApiTemplate({ mcpReservedConcurrency: '0' });
    expect(mcpFunctionProperties(none)).not.toHaveProperty('ReservedConcurrentExecutions');
    expect(() => synthApiTemplate({ mcpReservedConcurrency: '-1' })).toThrow(/mcpReservedConcurrency/);
  }, SYNTH_TIMEOUT_MS * 3);

  it('parses the context strictly: absent = default, whole numbers only', () => {
    const parse = (value: unknown) => nonNegativeIntegerContext(value, 'k', 20, 'usage');
    expect([parse(undefined), parse(null), parse('0'), parse(' 12 '), parse(7)]).toStrictEqual([20, 20, 0, 12, 7]);
    for (const bad of ['-1', '1.5', 'abc', '', -3, 2.5, true]) expect(() => parse(bad), String(bad)).toThrow(/Unrecognized k/);
  });

  it('gives no other API function a reservation', () => {
    const reserved = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .filter((fn) => propertiesOf(fn)?.ReservedConcurrentExecutions !== undefined);
    expect(reserved).toHaveLength(1);
  });

  it('tells the logs API the service its MCP alarms filter on', () => {
    expect(serviceEnvironment(apiTemplate(), GLOBAL_MCP_SERVICE_NAME).POWERTOOLS_SERVICE_NAME).toBe(GLOBAL_MCP_SERVICE_NAME);
    expect(serviceEnvironment(apiTemplate(), 'voc-logs-api').OPS_ALERTS_MCP_SERVICE).toBe(GLOBAL_MCP_SERVICE_NAME);
  });
});
