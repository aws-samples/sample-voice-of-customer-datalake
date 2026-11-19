/**
 * The GitHub App user authorizations' infrastructure (7.57.00, engineering-user-auth.ts, engineering-user-auth-parameters.ts,
 * api-engineering-user-auth.ts; docs/autonomous-engineering.md "Any public repository"): the code exchange's function
 * and its exact grants, the broker's read and refresh of the people's tokens for its upstream pull request, the Agents
 * API's writes (never a read), and the negative pins: no other role of any stack reaches the user authorizations' path,
 * and the connections' grant (the broker's and the checkout cache writer's) never matches it.
 */
import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import { policyStatementsOf, serviceEnvironment, synthApiTemplate } from '../test-support/api-stack-template';
import {
  functionIds, functionRoleId, functionStatements, functionUrlAuthTypes, permissionsNaming, processingSynths, templatesOnce,
} from '../test-support/engineering-template';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { engineeringParameterPrefix } from './engineering-broker';
import { engineeringUserAuthPrefix } from './engineering-user-auth-parameters';

const ARN = (resource: string) => ({
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:ssm:us-east-1:111111111111:parameter/${resource}`]],
});
const CLIENTS = ARN('voc/engineering-user-auth/app/*/client');
const USERS = ARN('voc/engineering-user-auth/user/*');
const APPS = ARN('voc/engineering-user-auth/app/*');
const USER_AUTH_FUNCTION = 'voc-engineering-user-auth';
/** What every grant on the path names (a resource, or a kms condition's PARAMETER_ARN). */
const PATH = 'engineering-user-auth';
const VIA_SSM = { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' };

function oneFunctionId(template: Template, name: string): string {
  const ids = functionIds(template, name);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

/** The logical ids of the roles whose policies (attached, inline or managed) mention `needle`, sorted. */
function rolesNaming(template: Template, needle: string): string[] {
  const attached = [
    ...Object.values(template.findResources('AWS::IAM::Policy')),
    ...Object.values(template.findResources('AWS::IAM::ManagedPolicy')),
  ].filter((policy) => JSON.stringify(policy.Properties?.PolicyDocument ?? {}).includes(needle))
    .flatMap((policy) => JSON.stringify(policy.Properties?.Roles ?? []).match(/"Ref":"[^"]+"/g) ?? [])
    .map((ref) => ref.slice('"Ref":"'.length, -1));
  const inline = Object.entries(template.findResources('AWS::IAM::Role'))
    .filter(([, role]) => JSON.stringify(role.Properties?.Policies ?? []).includes(needle)).map(([id]) => id);
  return [...new Set([...attached, ...inline])].sort(byCodeUnit);
}

/** Whether the IAM resource pattern `glob` (`*` any run of characters) matches `name`. */
function globMatches(glob: string, name: string): boolean {
  const pattern = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`, 'u').test(name);
}

// (one synth of each context for the file: both Processing suites read them)
const template = processingSynths({ off: {}, on: { engineeringAgents: true } });

describe('the code exchange (VocProcessingStack)', () => {
  it('is absent without the engineering agents', () => {
    expect(functionIds(template('off'), USER_AUTH_FUNCTION)).toStrictEqual([]);
  });

  it('runs the connectors\' code at its own entry, without the signing layer, and no function URL', () => {
    const on = template('on');
    const id = oneFunctionId(on, USER_AUTH_FUNCTION);
    const properties = on.findResources('AWS::Lambda::Function')[id]?.Properties;
    expect(properties).toMatchObject({
      Handler: 'engineering/connectors/user_auth.lambda_handler', Runtime: 'python3.14', Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES[USER_AUTH_FUNCTION], Timeout: 15,
      Environment: { Variables: { ENGINEERING_USER_AUTH_PREFIX: '/voc/engineering-user-auth/' } },
    });
    expect(JSON.stringify(properties?.Environment?.Variables?.ENGINEERING_PARAMETER_KEY)).toContain('Fn::ImportValue');
    expect(JSON.stringify(properties?.Layers)).not.toContain('SigningDepsLayer');
    expect(functionUrlAuthTypes(on, id)).toStrictEqual([]);
  });

  it('grants nobody a way in by resource policy: only roles an IAM policy names may invoke it', () => {
    const on = template('on');
    expect(permissionsNaming(on, oneFunctionId(on, USER_AUTH_FUNCTION))).toStrictEqual([]);
  });

  it('holds its log writes, a read of the Apps\' OAuth clients and a put of the people\'s tokens, and nothing else', () => {
    const on = template('on');
    const statements = functionStatements(on, oneFunctionId(on, USER_AUTH_FUNCTION));
    expect(statements.flatMap((statement) => [statement.Action].flat()).sort(byCodeUnit)).toStrictEqual([
      'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'logs:CreateLogStream', 'logs:PutLogEvents',
      'ssm:GetParameter', 'ssm:PutParameter']);
    expect(statements.find((statement) => statement.Action === 'ssm:GetParameter')).toMatchObject({ Resource: CLIENTS });
    expect(statements.find((statement) => statement.Action === 'ssm:PutParameter')).toMatchObject({ Resource: USERS });
  });

  it('uses the stack\'s key through SSM alone: to decrypt the clients, to encrypt the tokens', () => {
    const on = template('on');
    const statements = functionStatements(on, oneFunctionId(on, USER_AUTH_FUNCTION));
    expect(statements.find((statement) => statement.Action === 'kms:Decrypt')).toMatchObject({
      Condition: { StringEquals: VIA_SSM, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': CLIENTS } },
    });
    expect(statements.find((statement) => JSON.stringify(statement.Action).includes('kms:Encrypt'))).toMatchObject({
      Action: ['kms:Encrypt', 'kms:GenerateDataKey'],
      Condition: { StringEquals: VIA_SSM, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': USERS } },
    });
  });

  it('names the path outside the connections\' one, the deployment prefix on its voc segment', () => {
    expect(engineeringUserAuthPrefix(undefined)).toBe('/voc/engineering-user-auth/');
    expect(engineeringUserAuthPrefix('qa')).toBe('/qa-voc/engineering-user-auth/');
  });
});

describe('the broker\'s user authorizations (VocProcessingStack)', () => {
  const brokerStatements = () => functionStatements(template('on'), oneFunctionId(template('on'), 'voc-engineering-broker'));

  it('reads the Apps\' OAuth clients and the people\'s tokens, and puts the tokens alone (a refresh)', () => {
    const statements = brokerStatements();
    expect(statements.find((statement) => statement.Sid === 'UserAuthorizationReads')).toMatchObject({
      Action: 'ssm:GetParameter', Resource: [CLIENTS, USERS] });
    expect(statements.filter((statement) => statement.Action === 'ssm:PutParameter')).toStrictEqual([
      expect.objectContaining({ Sid: 'UserAuthorizationRefresh', Resource: USERS })]);
    expect(JSON.stringify(statements)).not.toMatch(/ssm:DeleteParameter|ssm:\*/);
  });

  it('uses the stack\'s key through SSM for them alone: decrypt both, encrypt the tokens', () => {
    const statements = brokerStatements();
    expect(statements.find((statement) => statement.Sid === 'UserAuthorizationReadsKey')).toMatchObject({
      Action: 'kms:Decrypt',
      Condition: { StringEquals: VIA_SSM, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': [CLIENTS, USERS] } },
    });
    expect(statements.find((statement) => statement.Sid === 'UserAuthorizationRefreshKey')).toMatchObject({
      Action: ['kms:Encrypt', 'kms:GenerateDataKey'],
      Condition: { StringEquals: VIA_SSM, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': USERS } },
    });
  });

  it('names the path and the stack\'s key, to put a refreshed token under it', () => {
    const on = template('on');
    const variables = on.findResources('AWS::Lambda::Function')[oneFunctionId(on, 'voc-engineering-broker')]?.Properties
      ?.Environment?.Variables;
    expect(variables?.ENGINEERING_USER_AUTH_PREFIX).toBe('/voc/engineering-user-auth/');
    expect(JSON.stringify(variables?.ENGINEERING_PARAMETER_KEY)).toContain('Fn::ImportValue');
  });

  it('leaves the path to the broker and the code exchange alone: no agent role, cache writer, start, token or other role', () => {
    const on = template('on');
    expect(rolesNaming(on, PATH)).toStrictEqual([
      functionRoleId(on, oneFunctionId(on, 'voc-engineering-broker')),
      functionRoleId(on, oneFunctionId(on, USER_AUTH_FUNCTION))].sort(byCodeUnit));
  });

  it('never lets the connections\' grant (the broker\'s, the checkout cache writer\'s) match the path', () => {
    const names = (prefix: string | undefined) => ['app/1234/client', 'user/1234/ab12'].map(
      (leaf) => `${engineeringUserAuthPrefix(prefix)}${leaf}`);
    const connections = (prefix: string | undefined) => `${engineeringParameterPrefix(prefix)}*`;
    expect(names(undefined).filter((name) => globMatches(connections(undefined), name))).toStrictEqual([]);
    expect(names('qa').filter((name) => globMatches(connections('qa'), name))).toStrictEqual([]);
    // (the pattern itself does match a connection's parameter: the check is not vacuous)
    expect(globMatches(connections(undefined), `${engineeringParameterPrefix(undefined)}my-repo`)).toBe(true);
  });
});

describe('the Agents API and the other stacks (VocApiStack, VocIngestionStack)', () => {
  const api = templatesOnce({
    off: () => synthApiTemplate({}, ['github_issues']),
    on: () => synthApiTemplate({ engineeringAgents: true }, ['github_issues']),
    ingestion: () => synthIngestionTemplate(['github_issues'], { engineeringAgents: true }),
  });
  const agentsStatements = () => policyStatementsOf(api('on'), 'AgentsLambdaRole');

  it('lets the Agents API invoke the code exchange by its name, and names it and the path', () => {
    const invokes = agentsStatements().filter((statement) => statement.actions.includes('lambda:InvokeFunction')
      && statement.resource.includes(USER_AUTH_FUNCTION));
    expect(invokes.map((statement) => statement.resource)).toStrictEqual([
      expect.stringMatching(/:function:voc-engineering-user-auth-",{"Ref":"AWS::AccountId"}/)]);
    const env = serviceEnvironment(api('on'), 'voc-agents-api');
    expect(JSON.stringify(env.ENGINEERING_USER_AUTH_FUNCTION)).toContain(`"${USER_AUTH_FUNCTION}-"`);
    expect(env.ENGINEERING_USER_AUTH_PREFIX).toBe('/voc/engineering-user-auth/');
  });

  it('puts and deletes the Apps\' OAuth clients, deletes a person\'s token, and reads neither', () => {
    const ssm = agentsStatements().filter((statement) => statement.resource.includes(PATH)
      && statement.actions.some((action) => action.startsWith('ssm:')));
    expect(ssm.map((statement) => [[...statement.actions].sort(byCodeUnit), statement.resource])).toStrictEqual([
      [['ssm:DeleteParameter', 'ssm:PutParameter'], JSON.stringify(APPS)],
      [['ssm:DeleteParameter'], JSON.stringify(USERS)]]);
    expect(JSON.stringify(agentsStatements())).not.toMatch(/ssm:Get|ssm:\*|ssm:Describe/);
  });

  it('encrypts an OAuth client with the stack\'s key only through SSM and only for the clients\' path', () => {
    const keys = agentsStatements().filter((statement) => statement.actions.includes('kms:Encrypt')
      && JSON.stringify(statement.condition).includes(PATH));
    expect(keys.map((statement) => [[...statement.actions].sort(byCodeUnit), statement.condition])).toStrictEqual([
      [['kms:Encrypt', 'kms:GenerateDataKey'],
        { StringEquals: VIA_SSM, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': APPS } }]]);
  });

  it('grants nothing on the path while the module is off, and to no other API role (the webhook\'s, the MCP\'s)', () => {
    expect(rolesNaming(api('off'), PATH)).toStrictEqual([]);
    expect(rolesNaming(api('on'), PATH)).toStrictEqual([expect.stringMatching(/AgentsLambdaRole/)]);
    expect(JSON.stringify(serviceEnvironment(api('off'), 'voc-agents-api'))).not.toContain(PATH);
  });

  it('gives the github_issues ingestor, and every other role of the ingestion stack, nothing on the path', () => {
    expect(rolesNaming(api('ingestion'), PATH)).toStrictEqual([]);
    expect(rolesNaming(api('ingestion'), 'voc-engineering-app-tokens')).not.toStrictEqual([]);
  });
});
