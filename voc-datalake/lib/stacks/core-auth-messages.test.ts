/**
 * The app pool's custom-message trigger (core-auth.ts → lambda/auth/user_messages.py):
 * - it is a real, self-contained asset (`auth/user_messages.handler`, only USER_MESSAGES_FILES), no inline code;
 * - it may read exactly the brand row (GetItem, LeadingKeys SETTINGS#brand) and decrypt with the table's key;
 * - `-c workshop` reaches it as WORKSHOP (default false), and the temporary-password lifetime it states is the
 *   pool's own policy;
 * - the static invitation (Cognito's fallback when the trigger fails) still carries both required placeholders.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { defined, isRecord, itemAt, recordAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { BRAND_SETTINGS_PK, DESIGN_SYSTEM_SETTINGS_PK, TEMPORARY_PASSWORD_DAYS, USER_MESSAGES_FILES } from './core-auth';
import { copyStepsFor, onlyTheseFiles } from '../utils/self-contained-trigger';
import { COMPANY_LOGO_PATH_PATTERN } from './core-cdn';

const HANDLER = 'auth/user_messages.handler';
const APP_POOL = { UserPoolName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-user-pool-'])] }) };

function only(template: Template, type: string, properties: Record<string, unknown>): { id: string; props: Record<string, unknown> } {
  const found = Object.entries(template.findResources(type, { Properties: properties }));
  expect(found).toHaveLength(1);
  const [id, resource] = itemAt(found, 0);
  return { id, props: defined(recordAt(resource, 'Properties'), `${id} Properties`) };
}

function triggerEnvironment(template: Template): Record<string, unknown> {
  const { props } = only(template, 'AWS::Lambda::Function', { Handler: HANDLER });
  return defined(recordAt(props, 'Environment', 'Variables'), 'trigger environment');
}

/** The trigger role's policy statements (CDK's DefaultPolicy attached to the role in `Role: GetAtt`). */
function triggerStatements(template: Template): Record<string, unknown>[] {
  const { props } = only(template, 'AWS::Lambda::Function', { Handler: HANDLER });
  const getAtt = recordAt(props, 'Role')?.['Fn::GetAtt'];
  const roleId = Array.isArray(getAtt) && typeof getAtt[0] === 'string' ? getAtt[0] : '';
  expect(roleId).not.toBe('');
  return Object.values(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: roleId }]) },
  })).flatMap((policy) => {
    const statements = recordAt(policy, 'Properties', 'PolicyDocument')?.Statement;
    return Array.isArray(statements) ? statements.filter(isRecord) : [];
  });
}

describe('app pool custom-message trigger', () => {
  let template: Template;
  beforeAll(() => { template = synthCoreTemplate(); }, SYNTH_TIMEOUT_MS);

  it('runs the bundled auth/user_messages.py, not inline code', () => {
    const { props } = only(template, 'AWS::Lambda::Function', { Handler: HANDLER });
    expect(props.Code).not.toHaveProperty('ZipFile');
    expect([...USER_MESSAGES_FILES]).toStrictEqual(['auth/user_messages.py', 'auth/logo_signing.py']);
    expect(onlyTheseFiles(USER_MESSAGES_FILES)).toStrictEqual(
      ['*', '!/auth/', '/auth/*', '!/auth/user_messages.py', '!/auth/logo_signing.py']);
    expect(copyStepsFor(USER_MESSAGES_FILES)).toStrictEqual([
      'mkdir -p /asset-output/auth',
      'cp /asset-input/auth/user_messages.py /asset-output/auth/user_messages.py',
      'cp /asset-input/auth/logo_signing.py /asset-output/auth/logo_signing.py',
    ]);
  });

  it('can sign the logo link: the CDN key pair in its environment and the crypto layer', () => {
    expect(triggerEnvironment(template)).toMatchObject({
      CDN_SIGNING_SECRET_ARN: { Ref: expect.stringMatching(/^CdnSigningKeySecret/) },
      CDN_SIGNING_KEY_PAIR_ID: { Ref: expect.stringMatching(/^CdnSigningPublicKey/) },
    });
    const { props } = only(template, 'AWS::Lambda::Function', { Handler: HANDLER });
    expect(props.Layers).toHaveLength(1);
  });

  it('may read the CDN signing key and no other secret', () => {
    const secretReads = triggerStatements(template).filter((s) => JSON.stringify(s.Action).includes('secretsmanager:'));
    expect(secretReads).toHaveLength(1);
    expect(itemAt(secretReads, 0).Action).toBe('secretsmanager:GetSecretValue');
    expect(JSON.stringify(itemAt(secretReads, 0).Resource)).toContain('CdnSigningKeySecret');
  });

  it('serves the uploaded logo, and nothing else under company-context/, only with a CDN signature', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions.flatMap((d) => {
      const list = recordAt(d, 'Properties', 'DistributionConfig')?.CacheBehaviors;
      return Array.isArray(list) ? list.filter(isRecord) : [];
    });
    const logo = behaviors.filter((b) => b.PathPattern === COMPANY_LOGO_PATH_PATTERN);
    expect(logo).toHaveLength(1);
    expect(itemAt(logo, 0)).toMatchObject({
      ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: ['GET', 'HEAD'],
      TrustedKeyGroups: [{ Ref: expect.stringMatching(/^CdnSigningKeyGroup/) }],
    });
    expect(COMPANY_LOGO_PATH_PATTERN).toBe('/company-context/design/logo_????????????.*');
    // No other behavior reaches the company-context/ prefix (references, previews, product docs stay unserved).
    expect(behaviors.filter((b) => String(b.PathPattern).startsWith('/company-context/'))).toHaveLength(1);
  });

  it('is the pool\'s custom-message trigger', () => {
    const { id } = only(template, 'AWS::Lambda::Function', { Handler: HANDLER });
    const pool = only(template, 'AWS::Cognito::UserPool', APP_POOL).props;
    expect(pool.LambdaConfig).toMatchObject({ CustomMessage: { 'Fn::GetAtt': [id, 'Arn'] } });
  });

  it('may read only the brand and design-system rows, and decrypt them', () => {
    const statements = triggerStatements(template);
    const dynamo = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb:'));
    expect(dynamo).toHaveLength(1);
    expect(itemAt(dynamo, 0)).toMatchObject({
      Action: 'dynamodb:GetItem',
      Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [BRAND_SETTINGS_PK, DESIGN_SYSTEM_SETTINGS_PK] } },
    });
    expect(statements.some((s) => JSON.stringify(s.Action).includes('kms:Decrypt'))).toBe(true);
  });

  it('is not a workshop deployment by default, and states the pool\'s temporary-password lifetime', () => {
    expect(triggerEnvironment(template)).toMatchObject({ WORKSHOP: 'false', TEMP_PASSWORD_DAYS: String(TEMPORARY_PASSWORD_DAYS) });
    const pool = only(template, 'AWS::Cognito::UserPool', APP_POOL).props;
    expect(pool.Policies).toMatchObject({ PasswordPolicy: { TemporaryPasswordValidityDays: TEMPORARY_PASSWORD_DAYS } });
  });

  it('keeps both placeholders in the static fallback invitation', () => {
    const pool = only(template, 'AWS::Cognito::UserPool', APP_POOL).props;
    const message = JSON.stringify(pool.AdminCreateUserConfig);
    expect(message).toContain('{username}');
    expect(message).toContain('{####}');
    expect(message).not.toContain('linear-gradient');
  });
});

describe('a workshop deployment', () => {
  it('tells the trigger, so an invitation without a brand names the workshop organizer', () => {
    expect(triggerEnvironment(synthCoreTemplate({ workshop: 'true' }))).toMatchObject({ WORKSHOP: 'true' });
  }, SYNTH_TIMEOUT_MS);

  it('refuses a misspelt flag at synth', () => {
    expect(() => synthCoreTemplate({ workshop: 'yes' })).toThrow(/Unrecognized workshop context value/);
  }, SYNTH_TIMEOUT_MS);
});
