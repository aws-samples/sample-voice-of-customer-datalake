/**
 * VocCoreStack's engagement storage and the feature-request board's user pool (5.33.00).
 *
 * - voc-participants / voc-feature-requests: pk/sk strings, one fully projected `gsi1`, on-demand,
 *   the stack KMS key, PITR, `-c protectData` removal and deletion protection, retained on
 *   replacement; TTL `ttl` on both (participants: the daily send counter; feature requests: the
 *   boards' rate-limit counters, added in 5.36.00 as an in-place update — same logical id, name, keys).
 * - The board pool exists on every deployment (5.45.00). With `-c emailFrom` it is exactly as
 *   docs/deployment.md describes (self sign-up behind the PreSignUp trigger, PASSWORD + EMAIL_OTP,
 *   Essentials, no recovery, SES from the address, one public USER_AUTH client) under the logical
 *   ids it had before 5.45.00, so an existing pool is updated in place. The no-sender shape is
 *   pinned in core-board-pool-default.test.ts.
 * - The app's own user pool and client are byte-identical with or without the board.
 *
 * The board cases fingerprint lambda/auth (the trigger code, the backend track's
 * lambda/auth/board_triggers.py), so they need that directory to exist.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { itemAt } from '../test-support/guards';
import { byCodeUnit } from '../utils/compare';

const EMAIL_FROM = 'noreply@voc.example.com';

let cachedDefault: Template | undefined;
let cachedBoard: Template | undefined;
const coreDefault = () => (cachedDefault ??= synthCoreTemplate());
const coreWithBoard = () => (cachedBoard ??= synthCoreTemplate({ emailFrom: EMAIL_FROM }));

// The default shape once, up front, under the synth timeout. (Not the board shape: it needs
// lambda/auth, and a beforeAll failure would hide the table cases too.)
beforeAll(() => {
  coreDefault();
}, SYNTH_TIMEOUT_MS);

function onlyResource(template: Template, type: string, props: Record<string, unknown>): { id: string; resource: Record<string, unknown> } {
  const found = Object.entries(template.findResources(type, { Properties: Match.objectLike(props) }));
  expect(found, `exactly one ${type} matching ${JSON.stringify(props)}`).toHaveLength(1);
  const [id, resource] = found[0] ?? ['', {}];
  return { id, resource };
}

/** The stack's data key (VocKmsKey). */
function onlyKmsKeyId(template: Template): string {
  const ids = Object.keys(template.findResources('AWS::KMS::Key')).filter((id) => id.startsWith('VocKmsKey'));
  expect(ids).toHaveLength(1);
  return itemAt(ids, 0);
}

/** The table whose TableName starts with `baseName-`. */
function tableNamed(template: Template, baseName: string) {
  return onlyResource(template, 'AWS::DynamoDB::Table', {
    TableName: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(`^${baseName}-$`)])] },
  });
}

const TableSchema = z.object({
  DeletionPolicy: z.string(),
  UpdateReplacePolicy: z.string(),
  Properties: z.object({
    KeySchema: z.array(z.object({ AttributeName: z.string(), KeyType: z.string() })),
    AttributeDefinitions: z.array(z.object({ AttributeName: z.string(), AttributeType: z.string() })),
    BillingMode: z.string(),
    PointInTimeRecoverySpecification: z.object({ PointInTimeRecoveryEnabled: z.boolean() }),
    SSESpecification: z.object({ SSEEnabled: z.boolean(), SSEType: z.string(), KMSMasterKeyId: z.unknown() }),
    DeletionProtectionEnabled: z.boolean().optional(),
    TimeToLiveSpecification: z.object({ AttributeName: z.string(), Enabled: z.boolean() }).optional(),
    GlobalSecondaryIndexes: z.array(z.object({
      IndexName: z.string(),
      KeySchema: z.array(z.object({ AttributeName: z.string(), KeyType: z.string() })),
      Projection: z.object({ ProjectionType: z.string() }),
    })),
  }),
});

const PK_SK = [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }];
const GSI1 = [{
  IndexName: 'gsi1',
  KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }],
  Projection: { ProjectionType: 'ALL' },
}];

describe.each([
  ['voc-participants', 'ttl'],
  ['voc-feature-requests', 'ttl'],
])('%s table', (baseName, ttl) => {
  const props = () => TableSchema.parse(tableNamed(coreDefault(), baseName).resource).Properties;

  it('is pk/sk (strings) with one fully projected gsi1', () => {
    const p = props();
    expect(p.KeySchema).toStrictEqual(PK_SK);
    expect(p.GlobalSecondaryIndexes).toStrictEqual(GSI1);
    expect(p.AttributeDefinitions.every((a) => a.AttributeType === 'S')).toBe(true);
  });

  it('is on-demand, KMS-encrypted with the stack key, PITR on', () => {
    const p = props();
    expect(p.BillingMode).toBe('PAY_PER_REQUEST');
    expect(p.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(p.SSESpecification).toStrictEqual({
      SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: { 'Fn::GetAtt': [onlyKmsKeyId(coreDefault()), 'Arn'] },
    });
  });

  it(`has TTL on ${ttl}`, () => {
    expect(props().TimeToLiveSpecification).toStrictEqual({ AttributeName: ttl, Enabled: true });
  });

  it('is deleted with the stack by default, but kept on replacement', () => {
    const table = TableSchema.parse(tableNamed(coreDefault(), baseName).resource);
    expect([table.DeletionPolicy, table.UpdateReplacePolicy]).toStrictEqual(['Delete', 'Retain']);
    expect(table.Properties.DeletionProtectionEnabled).toBeFalsy();
  });

  it('is kept and deletion-protected with -c protectData=true', () => {
    const table = TableSchema.parse(tableNamed(synthCoreTemplate({ protectData: true }), baseName).resource);
    expect([table.DeletionPolicy, table.UpdateReplacePolicy]).toStrictEqual(['RetainExceptOnCreate', 'Retain']);
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
  });
});

describe('voc-feature-requests TTL (5.36.00) is an in-place update', () => {
  // TimeToLiveSpecification updates without interruption; a replacement would need a new logical
  // id, table name or key schema, so those are pinned to what 5.33.00 deployed.
  it('keeps the logical id, the table name and the keys', () => {
    const table = tableNamed(coreDefault(), 'voc-feature-requests');
    expect(table.id).toMatch(/^FeatureRequestsTable[0-9A-F]{8}$/);
    expect(TableSchema.parse(table.resource).Properties.KeySchema).toStrictEqual(PK_SK);
  });
});

describe('board user pool', () => {
  const poolsOf = (template: Template) => Object.keys(template.findResources('AWS::Cognito::UserPool'));

  it('keeps the logical id it had before 5.45.00, with and without -c emailFrom (never replaced)', () => {
    // The id 5.33.00–5.44.x deployed with -c emailFrom: a different one would replace the pool
    // (and lose every board user) on the first 5.45.00 deploy of such a deployment.
    expect(poolsOf(coreWithBoard()).filter((id) => id.startsWith('VocBoardUserPool'))).toStrictEqual(['VocBoardUserPool2E856687']);
    expect(poolsOf(coreDefault()).filter((id) => id.startsWith('VocBoardUserPool'))).toStrictEqual(['VocBoardUserPool2E856687']);
  });

  it('rejects a malformed -c emailFrom at synth', () => {
    expect(() => synthCoreTemplate({ emailFrom: 'not-an-address' })).toThrow(/emailFrom/);
  });

  it('is created with -c emailFrom, exactly as documented', () => {
    const matching = coreWithBoard().findResources('AWS::Cognito::UserPool', {
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({
        UserPoolName: { 'Fn::Join': ['', Match.arrayWith(['voc-board-user-pool-'])] },
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
        UsernameAttributes: ['email'],
        UsernameConfiguration: { CaseSensitive: false },
        AutoVerifiedAttributes: ['email'],
        MfaConfiguration: 'OFF',
        AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] },
        UserPoolTier: 'ESSENTIALS',
        Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] } }),
        EmailConfiguration: {
          EmailSendingAccount: 'DEVELOPER',
          From: EMAIL_FROM,
          SourceArn: 'arn:aws:ses:us-east-1:111111111111:identity/voc.example.com',
        },
        LambdaConfig: {
          PreSignUp: { 'Fn::GetAtt': [Match.stringLikeRegexp('^BoardPreSignUpLambda'), 'Arn'] },
          CustomMessage: { 'Fn::GetAtt': [Match.stringLikeRegexp('^BoardCustomMessageLambda'), 'Arn'] },
        },
      }),
    });
    expect(Object.keys(matching)).toHaveLength(1);
  });

  it('has one public client: USER_AUTH + refresh, no secret, no OAuth, 10 min session, 1 h / 30 d tokens', () => {
    onlyResource(coreWithBoard(), 'AWS::Cognito::UserPoolClient', {
      ClientName: { 'Fn::Join': ['', Match.arrayWith(['voc-board-web-client-'])] },
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      AllowedOAuthFlowsUserPoolClient: false,
      AuthSessionValidity: 10,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
    });
    const boardClients = Object.values(coreWithBoard().findResources('AWS::Cognito::UserPoolClient', {
      Properties: { UserPoolId: { Ref: Match.stringLikeRegexp('^VocBoardUserPool') } },
    }));
    expect(boardClients).toHaveLength(1);
  });

  it.each([
    ['BoardPreSignUpLambda', 'auth/board_triggers.handler'],
    ['BoardCustomMessageLambda', 'auth/board_triggers.handler'],
  ])('%s runs %s (Python 3.14, ARM64, 128 MB) with the table names and the SPA origin', (constructId, handler) => {
    const fns = Object.entries(coreWithBoard().findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith(constructId));
    expect(fns).toHaveLength(1);
    const fn = z.object({ Properties: z.object({
      Handler: z.string(), Runtime: z.string(), Architectures: z.array(z.string()), MemorySize: z.number(),
      Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
    }) }).parse(fns[0]?.[1]).Properties;
    expect([fn.Handler, fn.Runtime, fn.Architectures, fn.MemorySize]).toStrictEqual([handler, 'python3.14', ['arm64'], 128]);
    expect(Object.keys(fn.Environment.Variables).sort(byCodeUnit)).toStrictEqual(['FRONTEND_URL', 'LOG_LEVEL', 'PARTICIPANTS_TABLE', 'PROJECTS_TABLE']);
  });

  it('the custom-message trigger links to the SPA origin', () => {
    const fn = Object.entries(coreWithBoard().findResources('AWS::Lambda::Function'))
      .find(([id]) => id.startsWith('BoardCustomMessageLambda'));
    expect(JSON.stringify(fn?.[1])).toMatch(/"FRONTEND_URL":\{"Fn::Join":\["",\["https:\/\/",\{"Fn::GetAtt":\["FrontendDistribution/);
  });

  it('the pre-sign-up trigger may read participants + projects items (review links) and decrypt — nothing else', () => {
    const policy = Object.entries(coreWithBoard().findResources('AWS::IAM::Policy'))
      .find(([id]) => id.startsWith('BoardPreSignUpLambdaServiceRoleDefaultPolicy'));
    const statements = z.object({ Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(z.object({
      Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown(),
    })) }) }) }).parse(policy?.[1]).Properties.PolicyDocument.Statement;
    expect(statements.map((s) => [s.Action, JSON.stringify(s.Resource)])).toStrictEqual([
      ['dynamodb:GetItem', JSON.stringify([
        { 'Fn::GetAtt': [tableNamed(coreWithBoard(), 'voc-participants').id, 'Arn'] },
        { 'Fn::GetAtt': [tableNamed(coreWithBoard(), 'voc-projects').id, 'Arn'] },
      ])],
      ['kms:Decrypt', JSON.stringify({ 'Fn::GetAtt': [onlyKmsKeyId(coreWithBoard()), 'Arn'] })],
    ]);
  });

  it('is exported as BoardUserPoolId / BoardUserPoolClientId', () => {
    expect(Object.keys(coreWithBoard().findOutputs('*')).filter((k) => k.startsWith('BoardUserPool')).sort(byCodeUnit))
      .toStrictEqual(['BoardUserPoolClientId', 'BoardUserPoolId']);
  });
});

describe('the app user pool', () => {
  const appAuth = (template: Template) => ({
    ...template.findResources('AWS::Cognito::UserPool', { Properties: { UserPoolName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-user-pool-'])] }) } }),
    ...template.findResources('AWS::Cognito::UserPoolClient', { Properties: { ClientName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith(['voc-web-client-'])] }) } }),
  });

  it('is byte-identical with and without the board pool', () => {
    expect(Object.keys(appAuth(coreDefault()))).toHaveLength(2);
    expect(appAuth(coreWithBoard())).toStrictEqual(appAuth(coreDefault()));
  });
});
