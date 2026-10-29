/**
 * The board pool WITHOUT `-c emailFrom` (5.45.00, core-board-auth.ts): it exists on every
 * deployment and, with no SES sender, emails its codes through Cognito's own sender
 * (no-reply@verificationemail.com, 50 a day per account). EMAIL_OTP needs SES, so PASSWORD is the
 * only first factor (a password the SPA sets from an emailed reset code), and account recovery is
 * by email (the returning person's code IS the reset code). The `-c emailFrom` shape is pinned in
 * core-engagement.test.ts. Both shapes share the pool's and client's logical ids, so setting
 * `-c emailFrom` later updates the pool in place.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

let cachedDefault: Template | undefined;
let cachedEmail: Template | undefined;
const coreDefault = () => (cachedDefault ??= synthCoreTemplate());
const coreWithEmail = () => (cachedEmail ??= synthCoreTemplate({ emailFrom: 'noreply@voc.example.com' }));

beforeAll(() => {
  coreDefault();
  coreWithEmail();
}, SYNTH_TIMEOUT_MS * 2);

const BOARD_POOL_NAME = { 'Fn::Join': ['', Match.arrayWith(['voc-board-user-pool-'])] };

const PoolSchema = z.object({
  Properties: z.object({
    EmailConfiguration: z.object({ EmailSendingAccount: z.string(), From: z.string().optional() }),
    Policies: z.object({ SignInPolicy: z.object({ AllowedFirstAuthFactors: z.array(z.string()) }) }),
    AccountRecoverySetting: z.object({ RecoveryMechanisms: z.array(z.object({ Name: z.string(), Priority: z.number() })) }),
    AdminCreateUserConfig: z.object({ AllowAdminCreateUserOnly: z.boolean() }),
    UserPoolTier: z.string(),
    LambdaConfig: z.record(z.string(), z.unknown()),
  }),
});

function boardPool(template: Template): { id: string; props: z.infer<typeof PoolSchema>['Properties'] } {
  const found = Object.entries(template.findResources('AWS::Cognito::UserPool', {
    Properties: Match.objectLike({ UserPoolName: BOARD_POOL_NAME }),
  }));
  expect(found).toHaveLength(1);
  const [id, resource] = found[0] ?? ['', {}];
  return { id, props: PoolSchema.parse(resource).Properties };
}

function boardClientId(template: Template): string {
  const ids = Object.keys(template.findResources('AWS::Cognito::UserPoolClient', {
    Properties: Match.objectLike({ ClientName: { 'Fn::Join': ['', Match.arrayWith(['voc-board-web-client-'])] } }),
  }));
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

describe('board pool without -c emailFrom', () => {
  it('sends its codes through Cognito’s default email (no SES sender)', () => {
    const { EmailConfiguration } = boardPool(coreDefault()).props;
    expect(EmailConfiguration).toStrictEqual({ EmailSendingAccount: 'COGNITO_DEFAULT' });
  });

  it('allows PASSWORD as the only first factor (EMAIL_OTP needs SES)', () => {
    expect(boardPool(coreDefault()).props.Policies.SignInPolicy.AllowedFirstAuthFactors).toStrictEqual(['PASSWORD']);
  });

  it('recovers accounts by verified email (the returning person’s code)', () => {
    expect(boardPool(coreDefault()).props.AccountRecoverySetting.RecoveryMechanisms)
      .toStrictEqual([{ Name: 'verified_email', Priority: 1 }]);
  });

  it('keeps self sign-up behind the same PreSignUp and CustomMessage triggers', () => {
    const { props } = boardPool(coreDefault());
    expect(props.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(false);
    expect(Object.keys(props.LambdaConfig).sort(byCodeUnit)).toStrictEqual(['CustomMessage', 'PreSignUp']);
    expect(props.UserPoolTier).toBe('ESSENTIALS');
  });

  it('outputs the pool, its client and the code sign-in mode', () => {
    const outputs = coreDefault().findOutputs('*');
    expect(['BoardUserPoolId', 'BoardUserPoolClientId', 'BoardSignInMode'].filter((key) => !(key in outputs))).toStrictEqual([]);
    expect(outputs.BoardSignInMode?.Value).toBe('code');
  });
});

describe('board pool with -c emailFrom', () => {
  it('outputs the EMAIL_OTP sign-in mode', () => {
    expect(coreWithEmail().findOutputs('BoardSignInMode').BoardSignInMode?.Value).toBe('email_otp');
  });

  it('has the same pool and client logical ids as the default shape (setting emailFrom never replaces the pool)', () => {
    expect([boardPool(coreWithEmail()).id, boardClientId(coreWithEmail())])
      .toStrictEqual([boardPool(coreDefault()).id, boardClientId(coreDefault())]);
  });
});
