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
import { Match, Template } from 'aws-cdk-lib/assertions';
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

describe('VocCoreStack admin bootstrap (issue #196)', () => {
  it('synthesizes deterministically — no per-synth password churn', () => {
    // The old code minted a random password at synth time, so every synth
    // produced a different template (and every deploy no-op-updated the
    // stack). Two independent synths must now be byte-identical.
    expect(synthCoreTemplate().toJSON()).toEqual(synthCoreTemplate().toJSON());
  });

  it('embeds no password in the template — generation happens at runtime', () => {
    const template = synthCoreTemplate();

    const bootstraps = template.findResources('Custom::AdminBootstrap');
    const props = Object.values(bootstraps).map((r) => r.Properties ?? {});
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ Username: 'admin', GroupName: 'admins' });
    expect(props[0]).not.toHaveProperty('Password');
  });

  it('wires InitialAdminPassword to the runtime attribute of the bootstrap resource', () => {
    const template = synthCoreTemplate();
    const output = template.findOutputs('InitialAdminPassword').InitialAdminPassword;
    const bootstrapLogicalIds = Object.keys(template.findResources('Custom::AdminBootstrap'));

    expect(output.Value).toEqual({ 'Fn::GetAtt': [bootstrapLogicalIds[0], 'Password'] });
  });

  it('keeps the provider framework logging at FATAL so Data.Password never reaches CloudWatch', () => {
    // At INFO the CDK provider framework logs the full custom resource
    // response — including the password. FATAL is today's aws-cdk-lib
    // default, but this pins the guarantee against dependency bumps and
    // debugging sessions alike.
    synthCoreTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('provider framework - onEvent .*AdminBootstrapProvider'),
      LoggingConfig: Match.objectLike({ ApplicationLogLevel: 'FATAL' }),
    });
  });
});

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
    // Guard against a vacuous pass: the pool must exist for the absence
    // assertion below to mean anything.
    expect(poolProps).toHaveLength(1);
    expect(poolProps[0]).not.toHaveProperty('UsernameConfiguration');
  });
});
