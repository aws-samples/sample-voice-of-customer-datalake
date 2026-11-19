/**
 * The public feedback widget on the SPA's distribution (lib/stacks/core-cdn.ts; docs/feedback-forms.md, "The script
 * embed"): `/widget/*` reads the SPA bucket through the default behavior's origin, with no signature (public by
 * design), GET and HEAD only, and its own headers policy: CORS for any origin without credentials, a 5-minute cache
 * and CORP cross-origin, on top of the SPA's own security headers, which stay exactly as they were for the app.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt, recordAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { WIDGET_CACHE_CONTROL, WIDGET_PATH_PATTERN } from './core-cdn';

const BehaviorSchema = z.object({
  PathPattern: z.string(),
  TargetOriginId: z.string(),
  TrustedKeyGroups: z.array(z.unknown()).optional(),
  AllowedMethods: z.array(z.string()),
  CachedMethods: z.array(z.string()),
  ViewerProtocolPolicy: z.string(),
  ResponseHeadersPolicyId: z.object({ Ref: z.string() }),
});
const ConfigSchema = z.object({
  DefaultCacheBehavior: z.object({ TargetOriginId: z.string(), ResponseHeadersPolicyId: z.object({ Ref: z.string() }) }),
  CacheBehaviors: z.array(z.looseObject({ PathPattern: z.string() })),
});

const state: { template: Template | null } = { template: null };
const template = (): Template => state.template ?? synthCoreTemplate();

beforeAll(() => {
  state.template = synthCoreTemplate();
}, SYNTH_TIMEOUT_MS);

function distributionConfig() {
  const distribution = itemAt(Object.values(template().findResources('AWS::CloudFront::Distribution')), 0);
  return ConfigSchema.parse(recordAt(distribution, 'Properties', 'DistributionConfig'));
}

function widgetBehavior() {
  return BehaviorSchema.parse(distributionConfig().CacheBehaviors.find((b) => b.PathPattern === WIDGET_PATH_PATTERN));
}

function policyConfig(ref: string) {
  return recordAt(template().findResources('AWS::CloudFront::ResponseHeadersPolicy')[ref], 'Properties',
    'ResponseHeadersPolicyConfig');
}

const customHeaders = (config: ReturnType<typeof policyConfig>) => z.array(z.object({
  Header: z.string(), Value: z.string(), Override: z.boolean(),
})).parse(recordAt(config, 'CustomHeadersConfig')?.Items);

describe('the public widget behaviour', () => {
  it('reads the SPA bucket through the default origin, without a signature, GET and HEAD only, HTTPS', () => {
    const widget = widgetBehavior();
    expect(widget.TargetOriginId).toBe(distributionConfig().DefaultCacheBehavior.TargetOriginId);
    expect(widget.TrustedKeyGroups).toBeUndefined();
    expect({ allowed: widget.AllowedMethods, cached: widget.CachedMethods, viewer: widget.ViewerProtocolPolicy })
      .toStrictEqual({ allowed: ['GET', 'HEAD'], cached: ['GET', 'HEAD'], viewer: 'redirect-to-https' });
  });

  it('has its own headers policy, not the SPA one', () => {
    expect(widgetBehavior().ResponseHeadersPolicyId).not.toStrictEqual(distributionConfig().DefaultCacheBehavior.ResponseHeadersPolicyId);
  });

  it('opens CORS to any origin for GET and HEAD, never with credentials', () => {
    expect(recordAt(policyConfig(widgetBehavior().ResponseHeadersPolicyId.Ref), 'CorsConfig')).toStrictEqual({
      AccessControlAllowCredentials: false,
      AccessControlAllowHeaders: { Items: ['*'] },
      AccessControlAllowMethods: { Items: ['GET', 'HEAD'] },
      AccessControlAllowOrigins: { Items: ['*'] },
      OriginOverride: true,
    });
  });

  it('caches for 5 minutes, loads cross-origin and keeps the permissions policy', () => {
    const headers = customHeaders(policyConfig(widgetBehavior().ResponseHeadersPolicyId.Ref));
    expect(WIDGET_CACHE_CONTROL).toBe('public, max-age=300');
    expect(headers).toStrictEqual([
      { Header: 'Permissions-Policy', Value: expect.stringContaining('camera=()'), Override: true },
      { Header: 'Cache-Control', Value: WIDGET_CACHE_CONTROL, Override: true },
      { Header: 'Cross-Origin-Resource-Policy', Value: 'cross-origin', Override: true },
    ]);
  });

  it('carries the SPA security headers unchanged (nosniff, HSTS, referrer, frame DENY and the CSP)', () => {
    const spa = policyConfig(distributionConfig().DefaultCacheBehavior.ResponseHeadersPolicyId.Ref);
    const widget = policyConfig(widgetBehavior().ResponseHeadersPolicyId.Ref);
    expect(recordAt(widget, 'SecurityHeadersConfig')).toStrictEqual(recordAt(spa, 'SecurityHeadersConfig'));
    expect(recordAt(widget, 'SecurityHeadersConfig', 'ContentTypeOptions')).toStrictEqual({ Override: true });
    expect(recordAt(widget, 'SecurityHeadersConfig', 'FrameOptions')).toStrictEqual({ FrameOption: 'DENY', Override: true });
  });

  it('leaves the SPA policy without CORS and with its own headers alone', () => {
    const spa = policyConfig(distributionConfig().DefaultCacheBehavior.ResponseHeadersPolicyId.Ref);
    expect(recordAt(spa, 'CorsConfig')).toBeUndefined();
    expect(customHeaders(spa).map((header) => header.Header)).toStrictEqual(['Permissions-Policy']);
    expect(String(recordAt(spa, 'SecurityHeadersConfig', 'ContentSecurityPolicy')?.ContentSecurityPolicy))
      .toContain("frame-ancestors 'none'; base-uri 'none';");
  });
});
