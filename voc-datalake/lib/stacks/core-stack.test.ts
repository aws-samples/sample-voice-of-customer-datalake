/**
 * Template-level tests for the Cognito User Pool's UsernameConfiguration.
 *
 * Regression guard for issue #184: signInCaseSensitive (#105) maps to
 * UsernameConfiguration, which Cognito treats as create-only — introducing
 * it on a pool deployed before #105 fails the entire VocCoreStack update
 * ("Updates are not allowed for property - UsernameConfiguration").
 * Pre-#105 environments deploy with `-c omitUserPoolUsernameConfiguration=true`
 * to keep their pool untouched; greenfield keeps case-insensitive sign-in.
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VocCoreStack } from './core-stack';

function synthCoreTemplate(context: Record<string, unknown> = {}): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true, ...context } });
  const stack = new VocCoreStack(app, 'TestCoreStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    brandName: 'TestBrand',
  });
  return Template.fromStack(stack);
}

describe('VocCoreStack UserPool UsernameConfiguration (issue #184)', () => {
  it('sets case-insensitive sign-in by default (greenfield)', () => {
    const template = synthCoreTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameConfiguration: { CaseSensitive: false },
    });
  });

  it('omits UsernameConfiguration entirely with the pre-#105 compatibility flag', () => {
    const template = synthCoreTemplate({ omitUserPoolUsernameConfiguration: true });

    const pools = template.findResources('AWS::Cognito::UserPool');
    const poolProps = Object.values(pools).map((p) => p.Properties ?? {});
    expect(poolProps).toHaveLength(1);
    // The property must be ABSENT — Cognito rejects any update that carries
    // it against a pool created without it.
    expect(poolProps[0]).not.toHaveProperty('UsernameConfiguration');
  });

  it('accepts the string form of the flag (CLI -c passes strings)', () => {
    const template = synthCoreTemplate({ omitUserPoolUsernameConfiguration: 'true' });

    const poolProps = Object.values(template.findResources('AWS::Cognito::UserPool'))
      .map((p) => p.Properties ?? {});
    expect(poolProps[0]).not.toHaveProperty('UsernameConfiguration');
  });
});
