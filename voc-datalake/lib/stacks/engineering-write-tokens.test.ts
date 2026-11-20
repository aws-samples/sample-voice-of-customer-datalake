/**
 * The fine-grained connections' write tokens (7.60.00, engineering-broker.ts, api-assistant-lambdas.ts;
 * lambda/engineering/connectors/credentials.py WriteTokens): one SecureString per token connection at
 * `/[<prefix>-]voc/engineering-token/<id>`, beside the connections' path and never under it. Over the WHOLE app with
 * every gated feature on (and every role on Kiro, which grants the agent roles the most): the broker alone reads them
 * (`ssm:GetParameter`, `kms:Decrypt` through SSM for them), the Agents API alone puts and deletes them (`kms:Encrypt`,
 * `kms:GenerateDataKey` through SSM for them), and no other role of any stack reaches them, by any SSM action or KMS
 * grant for their parameter: not the checkout cache's writer, the runtime (supervisor, launcher, start, reactions), an
 * agent role, the token function, the issues settings, the board and the router, the GitHub Issues ingestor and webhook,
 * nor the stream Lambda. Self-checking: the same scan finds the connections' readers on `/voc/engineering/<id>`, and
 * no role lists either path (`ssm:GetParametersByPath`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ALL_FEATURES_CONTEXT } from '../test-support/all-features-context';
import { globMatches } from '../test-support/iam-statements';
import { cleanupAssemblyDirs, SYNTH_ACCOUNT, SYNTH_REGION, synthApp } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { engineeringParameterPrefix, engineeringTokenParameterPrefix } from './engineering-broker';

const RESULT = synthApp({ ...ALL_FEATURES_CONTEXT, engineeringHarness: 'kiro' });
afterAll(cleanupAssemblyDirs);

const TOKEN = `arn:aws:ssm:${SYNTH_REGION}:${SYNTH_ACCOUNT}:parameter/voc/engineering-token/conn-1`;
const CONNECTION = `arn:aws:ssm:${SYNTH_REGION}:${SYNTH_ACCOUNT}:parameter/voc/engineering/conn-1`;

const StatementSchema = z.looseObject({
  Effect: z.string(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
  Condition: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
const ResourcesSchema = z.record(z.string(), z.looseObject({ Type: z.string(), Properties: z.unknown().optional() }));
const PolicySchema = z.looseObject({
  Roles: z.array(z.unknown()).optional(),
  PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
});

type Statement = z.infer<typeof StatementSchema>;
interface Located { readonly stack: string; readonly role: string; readonly statement: Statement }

const PSEUDO: Readonly<Record<string, string>> = {
  'AWS::Partition': 'aws', 'AWS::AccountId': SYNTH_ACCOUNT, 'AWS::Region': SYNTH_REGION,
};

/** A synthesized resource as a glob: an `Fn::Join` flattened, a pseudo parameter named, any other token `*`. */
function flat(resource: unknown): string {
  if (typeof resource === 'string') return resource;
  const joined = z.object({ 'Fn::Join': z.tuple([z.literal(''), z.array(z.unknown())]) }).safeParse(resource);
  if (!joined.success) return '*';
  return joined.data['Fn::Join'][1].map((part) => {
    if (typeof part === 'string') return part;
    const ref = z.object({ Ref: z.string() }).safeParse(part);
    return ref.success ? PSEUDO[ref.data.Ref] ?? '*' : '*';
  }).join('');
}

const actionsOf = (statement: Statement): string[] => [statement.Action].flat();
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** Every identity policy statement of the app, with its stack and the role it is attached to. */
const STATEMENTS: Located[] = RESULT.stackNames.flatMap((stack) => Object.values(ResourcesSchema.parse(
  RESULT.template(stack).Resources ?? {}))
  .filter((resource) => resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy')
  .flatMap((resource) => {
    const policy = PolicySchema.parse(resource.Properties);
    const roles = (policy.Roles ?? []).map((role) => JSON.stringify(role));
    return policy.PolicyDocument.Statement.flatMap((statement) => roles.map((role) => ({ stack, role, statement })));
  }));

/**
 * The SSM actions of a statement that reach a parameter's value or its life: every one but `ssm:DescribeParameters`
 * (metadata only, never a value; IAM takes it only on `*`: readiness's read of the Kiro key's type).
 */
const valueActions = (statement: Statement): string[] => actionsOf(statement)
  .filter((action) => (action.startsWith('ssm:') || action === '*') && action !== 'ssm:DescribeParameters');

/** The SSM statements (Allow) whose resources reach `parameter`'s value. */
function ssmReaching(parameter: string): Located[] {
  return STATEMENTS.filter(({ statement }) => statement.Effect === 'Allow' && valueActions(statement).length > 0
    && listOf(statement.Resource).some((resource) => globMatches(flat(resource), parameter)));
}

/** The KMS statements (Allow) whose SSM encryption context lets them work on `parameter`'s value. */
function keyReaching(parameter: string): Located[] {
  return STATEMENTS.filter(({ statement }) => {
    if (statement.Effect !== 'Allow' || !actionsOf(statement).some((action) => action.startsWith('kms:'))) return false;
    const context = statement.Condition?.StringLike?.['kms:EncryptionContext:PARAMETER_ARN']
      ?? statement.Condition?.StringEquals?.['kms:EncryptionContext:PARAMETER_ARN'];
    return context !== undefined && listOf(context).some((pattern) => globMatches(flat(pattern), parameter));
  });
}

const FunctionPropertiesSchema = z.looseObject({ FunctionName: z.unknown().optional(), Role: z.unknown().optional() });

/** `role` (a policy's `Roles` entry, as JSON) of the function whose physical name starts with `name`, in `stack`. */
function roleOf(stack: string, name: string): string {
  const functions = Object.values(ResourcesSchema.parse(RESULT.template(stack).Resources ?? {}))
    .filter((resource) => resource.Type === 'AWS::Lambda::Function')
    .map((resource) => FunctionPropertiesSchema.parse(resource.Properties ?? {}))
    .filter((properties) => JSON.stringify(properties.FunctionName ?? '').includes(name));
  expect(functions).toHaveLength(1);
  const role = JSON.stringify(functions[0]?.Role);
  const id = /"Fn::GetAtt":\["([^"]+)","Arn"\]/.exec(role)?.[1] ?? '';
  return JSON.stringify({ Ref: id });
}

const who = (found: Located[]) => [...new Set(found.map(({ stack, role }) => `${stack} ${role}`))].sort(byCodeUnit);
const actions = (found: Located[]) => [...new Set(found.flatMap(({ statement }) => actionsOf(statement)))]
  .filter((action) => action !== 'ssm:DescribeParameters').sort(byCodeUnit);

describe('the write tokens\' own path (7.60.00)', () => {
  it('is beside the connections\' path, never under it, unprefixed and prefixed', () => {
    expect([engineeringTokenParameterPrefix(undefined), engineeringTokenParameterPrefix('b')])
      .toStrictEqual(['/voc/engineering-token/', '/b-voc/engineering-token/']);
    for (const prefix of [undefined, 'b']) {
      // (every grant on a connection's parameter: `/[<prefix>-]voc/engineering/*`)
      const connections = `${engineeringParameterPrefix(prefix)}*`;
      expect([globMatches(connections, `${engineeringTokenParameterPrefix(prefix)}conn-1`),
        globMatches(connections, `${engineeringParameterPrefix(prefix)}conn-1`)]).toStrictEqual([false, true]);
    }
  });

  it('is read by the broker alone, and put and deleted by the Agents API alone', () => {
    const broker = `VocProcessingStack ${roleOf('VocProcessingStack', 'voc-engineering-broker')}`;
    const api = `VocApiStack ${roleOf('VocApiStack', 'voc-agents-api')}`;
    expect(who(ssmReaching(TOKEN))).toStrictEqual([api, broker].sort(byCodeUnit));
    const ssmOf = (role: string) => actions(ssmReaching(TOKEN).filter((found) => `${found.stack} ${found.role}` === role));
    expect([ssmOf(broker), ssmOf(api)]).toStrictEqual([['ssm:GetParameter'], ['ssm:DeleteParameter', 'ssm:PutParameter']]);
    expect(who(keyReaching(TOKEN))).toStrictEqual([api, broker].sort(byCodeUnit));
    const keyOf = (role: string) => actions(keyReaching(TOKEN).filter((found) => `${found.stack} ${found.role}` === role));
    expect([keyOf(broker), keyOf(api)]).toStrictEqual([['kms:Decrypt'], ['kms:Encrypt', 'kms:GenerateDataKey']]);
  });

  it('decrypts and encrypts it only through SSM', () => {
    const via = keyReaching(TOKEN).map(({ statement }) => statement.Condition?.StringEquals?.['kms:ViaService']);
    expect(new Set(via)).toStrictEqual(new Set([`ssm.${SYNTH_REGION}.amazonaws.com`]));
  });

  it('is reached by none of the connections\' other readers, though they reach the connections (the control)', () => {
    // (the scan's control: the broker, the checkout cache's writer and the Agents API reach a connection's parameter)
    expect(who(ssmReaching(CONNECTION)).length).toBeGreaterThanOrEqual(3);
    expect(who(ssmReaching(TOKEN))).toHaveLength(2);
    expect(who(ssmReaching(CONNECTION)).filter((role) => who(ssmReaching(TOKEN)).includes(role))).toHaveLength(2);
  });

  it('is listed by no role: no GetParametersByPath, no ssm:* on either path', () => {
    const listing = [...ssmReaching(TOKEN), ...ssmReaching(CONNECTION)]
      .filter(({ statement }) => valueActions(statement)
        .some((action) => /^ssm:(\*|GetParametersByPath|GetParameters)$/.test(action) || action === '*'));
    expect(listing).toStrictEqual([]);
  });
});
