/**
 * Prototype drafts on the SPA's distribution (lib/stacks/core-cdn.ts; docs/prototype-builder.md, part 2):
 * `/prototypes/*\/drafts/*` is its own behaviour, matched BEFORE `/prototypes/*` (which matches a draft
 * too, and would give it the live policy), read through the same origin, key group and cache as a live
 * prototype, with the narrower draft policy (PROTOTYPE_DRAFT_CSP: no allow-popups, no connect-src) and
 * no CSP function that could widen it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt, recordAt } from '../test-support/guards';
import { PROTOTYPE_DRAFT_CSP } from '../utils/prototype-csp';

const DRAFTS = '/prototypes/*/drafts/*';
const LIVE = '/prototypes/*';

const BehaviorSchema = z.object({
  PathPattern: z.string(),
  TargetOriginId: z.string(),
  TrustedKeyGroups: z.array(z.unknown()).optional(),
  CachePolicyId: z.unknown().optional(),
  ResponseHeadersPolicyId: z.unknown().optional(),
  AllowedMethods: z.array(z.string()).optional(),
  FunctionAssociations: z.array(z.unknown()).optional(),
});

function behaviors() {
  const distribution = itemAt(Object.values(synthCoreTemplate().findResources('AWS::CloudFront::Distribution')), 0);
  return z.array(BehaviorSchema).parse(recordAt(distribution, 'Properties', 'DistributionConfig')?.CacheBehaviors);
}

function behaviorAt(pattern: string) {
  const found = behaviors().find((behavior) => behavior.PathPattern === pattern);
  if (found === undefined) throw new Error(`no ${pattern} behaviour`);
  return found;
}

describe('the prototype drafts behaviour', () => {
  it('is matched before /prototypes/*', () => {
    const patterns = behaviors().map((behavior) => behavior.PathPattern);
    expect(patterns).toContain(DRAFTS);
    expect(patterns.indexOf(LIVE)).toBeGreaterThan(patterns.indexOf(DRAFTS));
  });

  it('reads through the same origin, key group, cache and methods as a live prototype', () => {
    const draft = behaviorAt(DRAFTS);
    const live = behaviorAt(LIVE);
    const access = (behavior: z.infer<typeof BehaviorSchema>) => ({
      origin: behavior.TargetOriginId, keyGroups: behavior.TrustedKeyGroups, cache: behavior.CachePolicyId,
      methods: behavior.AllowedMethods,
    });
    expect(draft.TrustedKeyGroups).toHaveLength(1);
    expect(access(draft)).toStrictEqual(access(live));
  });

  it('carries the draft policy, overriding the origin, and no CSP function', () => {
    const draft = behaviorAt(DRAFTS);
    const policyRef = z.object({ Ref: z.string() }).parse(draft.ResponseHeadersPolicyId);
    const policy = synthCoreTemplate().findResources('AWS::CloudFront::ResponseHeadersPolicy')[policyRef.Ref];
    expect(recordAt(policy, 'Properties', 'ResponseHeadersPolicyConfig', 'SecurityHeadersConfig',
      'ContentSecurityPolicy')).toStrictEqual({ ContentSecurityPolicy: PROTOTYPE_DRAFT_CSP, Override: true });
    expect(draft.FunctionAssociations ?? []).toStrictEqual([]);
    expect(policyRef).not.toStrictEqual(behaviorAt(LIVE).ResponseHeadersPolicyId);
  });
});
