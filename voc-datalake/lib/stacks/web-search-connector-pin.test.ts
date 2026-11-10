/**
 * The web-search gateway target is pinned to connector 1.2.0 (web-search-connector-pin.ts):
 * Radar's release scan sends request filters only that version accepts.
 */
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { VocWebSearchStack } from './web-search-stack';
import { WEB_SEARCH_CONNECTOR_PIN_TYPE, WEB_SEARCH_CONNECTOR_VERSION } from './web-search-connector-pin';

const PinSchema = z.object({
  Properties: z.object({ Create: z.unknown(), Update: z.unknown() }),
  DependsOn: z.array(z.string()),
});

const USE_CASE = {
  companyName: 'Example', companyWebsite: 'https://example.com', intendedUsers: '0' as const,
  industryOption: 'Technology' as const, otherIndustryOption: '', useCases: 'Pin tests for the web-search connector.',
};

function pinsOf(deployWebSearch: boolean): z.infer<typeof PinSchema>[] {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new VocWebSearchStack(app, 'Pin', {
    env: { account: '123456789012', region: 'us-east-1' }, deployWebSearch,
    anthropicUseCase: deployWebSearch ? undefined : USE_CASE,
  });
  return Object.values(Template.fromStack(stack).findResources(WEB_SEARCH_CONNECTOR_PIN_TYPE)).map((r) => PinSchema.parse(r));
}

describe('the web-search connector version pin', () => {
  it('updates the target in place to 1.2.0 on create and on update', () => {
    const pins = pinsOf(true);
    expect(pins).toHaveLength(1);
    const [pin] = pins;
    const create = JSON.stringify(pin?.Properties.Create);
    expect(create).toContain('UpdateGatewayTarget');
    expect(create).toContain(`\\"version\\":\\"${WEB_SEARCH_CONNECTOR_VERSION}\\"`);
    expect(JSON.stringify(pin?.Properties.Update)).toContain('UpdateGatewayTarget');
  });

  it('runs after the target exists, and keeps its name (the MCP tool prefix)', () => {
    const [pin] = pinsOf(true);
    expect(pin?.DependsOn.some((id) => id.startsWith('WebSearchGatewayTarget'))).toBe(true);
    expect(JSON.stringify(pin?.Properties.Create)).toContain('\\"name\\":\\"web-search-tool\\"');
  });

  it('is absent when the web-search half is off', () => {
    expect(pinsOf(false)).toStrictEqual([]);
  });
});
