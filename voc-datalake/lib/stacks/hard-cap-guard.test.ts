/**
 * The engineering hard cap's row in voc-agents (`SETTINGS#engineering`: `HARD_CAP` and its `LOG#` history,
 * lambda/engineering/settings.py) and the repository connections' rows (`CONNECTIONS#<ws>`: each connection and its
 * `LOG#` audit rows, lambda/engineering/connectors/connections.py) across the whole app, with the engineering module
 * on: the Agents API is their one writer, and every other role that may write voc-agents is explicitly denied
 * writing those partitions (engineering-runtime-grants.ts denyHardCapWrites).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { statementsByRole, type IamStatement } from '../test-support/iam-statements';
import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { CONNECTIONS_PARTITIONS, HARD_CAP_DENY_SID, HARD_CAP_PARTITION } from './engineering-runtime-grants';

const WRITES = /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/;
const AGENTS_TABLE = /AgentsTable[0-9A-F]{8}/;
/** The hard cap's one writer (PUT /agents/engineering/settings). */
const WRITER = 'VocApiStack/AgentsLambdaRole';

const synthed = synthApp({ engineeringAgents: 'true' });
afterAll(cleanupAssemblyDirs);

const writesAgentsTable = (statements: IamStatement[]): boolean => statements.some((statement) =>
  (statement.Effect ?? 'Allow') === 'Allow' && [statement.Action].flat().some((action) => WRITES.test(action))
  && AGENTS_TABLE.test(JSON.stringify(statement.Resource)));

const byRole = [...statementsByRole(synthed)].filter(([, statements]) => writesAgentsTable(statements));
const others = byRole.filter(([role]) => !role.endsWith(WRITER.split('/')[1] ?? WRITER));

describe('the engineering hard cap\'s row in voc-agents', () => {
  it('finds the Agents API and the agents\' runtime roles among voc-agents\' writers', () => {
    expect(byRole.map(([role]) => role)).toContain(WRITER);
    expect(others.length).toBeGreaterThanOrEqual(4);   // the conductor, the nodes, the persona panel, the heartbeat
  }, SYNTH_TIMEOUT_MS);

  it.each(others)('denies %s every write on SETTINGS#engineering and the connections\' partitions', (_role, statements) => {
    const deny = statements.find((statement) => statement.Sid === HARD_CAP_DENY_SID);
    expect(deny).toMatchObject({
      Effect: 'Deny',
      // (sorted by the app's exact-grants rewrite)
      Action: ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      Condition: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [HARD_CAP_PARTITION, CONNECTIONS_PARTITIONS] } },
    });
    expect(JSON.stringify(deny?.Resource)).toMatch(AGENTS_TABLE);
  });

  it('leaves the Agents API, its one writer, without the Deny', () => {
    const [, statements] = byRole.find(([role]) => role === WRITER) ?? [WRITER, []];
    expect(statements.some((statement) => statement.Sid === HARD_CAP_DENY_SID)).toBe(false);
  });
});
