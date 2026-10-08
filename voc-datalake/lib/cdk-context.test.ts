/**
 * cdk.context.json is committed CONFIGURATION, never a lookup cache (issue #267 item 13).
 *
 * The CDK CLI writes context-provider results (`availability-zones:account=…`,
 * `vpc-provider:account=…`, …) into this file. They are account-specific, were
 * committed by whoever last synthesized, and pin nothing for anybody else: no stack
 * here uses an EC2/VPC lookup or `Stack.availabilityZones`. Should one ever need a
 * lookup, its cache entry must be a deliberate, documented addition — this guard is
 * where to record why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const context = z.record(z.string(), z.unknown())
  .parse(JSON.parse(readFileSync(join(__dirname, '..', 'cdk.context.json'), 'utf8')));

describe('cdk.context.json', () => {
  it('holds no account-scoped context-provider lookups', () => {
    expect(Object.keys(context).filter((key) => /:account=/.test(key))).toStrictEqual([]);
  });

  it('keeps the plugin and menu configuration', () => {
    expect(['pluginStatus', 'menuStatus'].filter((key) => key in context)).toStrictEqual(['pluginStatus', 'menuStatus']);
  });
});
