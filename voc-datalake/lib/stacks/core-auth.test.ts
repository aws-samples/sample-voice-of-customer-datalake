/**
 * The app user pool and web client (core-auth.ts):
 * - opt-in passkeys (WA SEC02): a passkey is a first factor next to the password, on the Essentials
 *   plan, with the SPA's own site as the relying party; the client carries the USER_AUTH flow passkey
 *   sign-in uses. MFA stays off: a passkey is offered, never required.
 * - OAuth redirect URLs (IAM-8): production redirects only to its own site; the Vite dev server on
 *   localhost is added for `-c environment=dev` alone.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const APP_POOL = { UserPoolName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-user-pool-'])] }) };
const APP_CLIENT = { ClientName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-web-client-'])] }) };

/** The one resource matching `properties` (the board pool and client are other resources). */
function onlyProperties(template: Template, type: string, properties: Record<string, unknown>): Record<string, unknown> {
  const found = Object.values(template.findResources(type, { Properties: properties }));
  expect(found).toHaveLength(1);
  return itemAt(found, 0).Properties;
}

describe('app user pool passkeys', () => {
  let template: Template;
  beforeAll(() => { template = synthCoreTemplate(); }, SYNTH_TIMEOUT_MS);

  it('allows a passkey as a first factor next to the password, on the Essentials plan, verifying the user', () => {
    expect(onlyProperties(template, 'AWS::Cognito::UserPool', APP_POOL)).toMatchObject({
      UserPoolTier: 'ESSENTIALS',
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] } },
      WebAuthnUserVerification: 'required',
    });
  });

  it('names the site the SPA is served from as the relying party', () => {
    const siteDomain = template.findOutputs('DistributionDomainName').DistributionDomainName?.Value;
    expect(siteDomain).toBeDefined();
    expect(onlyProperties(template, 'AWS::Cognito::UserPool', APP_POOL).WebAuthnRelyingPartyID).toStrictEqual(siteDomain);
  });

  it('gives the web client the USER_AUTH flow, keeping password and SRP sign-in', () => {
    expect(onlyProperties(template, 'AWS::Cognito::UserPoolClient', APP_CLIENT).ExplicitAuthFlows).toStrictEqual(
      ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    );
  });

  it('names no localhost OAuth URL in a production deployment', () => {
    const { CallbackURLs, LogoutURLs } = onlyProperties(template, 'AWS::Cognito::UserPoolClient', APP_CLIENT);
    expect(JSON.stringify([CallbackURLs, LogoutURLs])).not.toContain('localhost');
  });
});

describe('app client OAuth URLs in a dev deployment', () => {
  it('adds the Vite dev server', () => {
    const { CallbackURLs, LogoutURLs } = onlyProperties(synthCoreTemplate({ environment: 'dev' }), 'AWS::Cognito::UserPoolClient', APP_CLIENT);
    expect(JSON.stringify([CallbackURLs, LogoutURLs])).toContain('http://localhost:5173/callback');
  }, SYNTH_TIMEOUT_MS);
});
