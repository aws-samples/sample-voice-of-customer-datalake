/**
 * Opt-in passkeys on the app user pool (WA SEC02): the pool allows a passkey as a first factor next to
 * the password, on the Essentials plan, with the SPA's own site as the relying party, and the web client
 * carries the USER_AUTH flow passkey sign-in uses. MFA stays off: a passkey is offered, never required.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt } from '../test-support/guards';

const APP_POOL = { UserPoolName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-user-pool-'])] }) };
const APP_CLIENT = { ClientName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-web-client-'])] }) };

describe('app user pool passkeys', () => {
  let template: Template;
  beforeAll(() => { template = synthCoreTemplate(); });

  /** The one app pool's synthesized properties (the board pool is another resource). */
  function appPoolProperties(): Record<string, unknown> {
    const pools = Object.values(template.findResources('AWS::Cognito::UserPool', { Properties: APP_POOL }));
    expect(pools).toHaveLength(1);
    return itemAt(pools, 0).Properties;
  }

  it('allows a passkey as a first factor next to the password, on the Essentials plan, verifying the user', () => {
    const pool = appPoolProperties();
    expect(pool).toMatchObject({
      UserPoolTier: 'ESSENTIALS',
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] } },
      WebAuthnUserVerification: 'required',
    });
  });

  it('names the site the SPA is served from as the relying party', () => {
    const siteDomain = template.findOutputs('DistributionDomainName').DistributionDomainName?.Value;
    expect(siteDomain).toBeDefined();
    expect(appPoolProperties().WebAuthnRelyingPartyID).toStrictEqual(siteDomain);
  });

  it('gives the web client the USER_AUTH flow, keeping password and SRP sign-in', () => {
    const clients = Object.values(template.findResources('AWS::Cognito::UserPoolClient', { Properties: APP_CLIENT }));
    expect(clients).toHaveLength(1);
    expect(itemAt(clients, 0).Properties.ExplicitAuthFlows).toStrictEqual(
      ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    );
  });
});
