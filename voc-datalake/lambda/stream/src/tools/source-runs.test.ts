import { describe, expect, it } from 'vitest';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { readSourceRun } from './source-runs.js';

describe('readSourceRun', () => {
  function client(answer: Record<string, unknown>) {
    const sent: unknown[] = [];
    return { sent, docClient: { send: (command: unknown) => { sent.push(command); return Promise.resolve(answer); } } };
  }

  it('gets one execution by its key', async () => {
    const { docClient, sent } = client({ Item: { sk: 'run_1', status: 'running' } });
    expect(await readSourceRun(docClient, 'aggregates', 'app_reviews_ios', 'run_1')).toStrictEqual({ sk: 'run_1', status: 'running' });
    expect(sent[0]).toBeInstanceOf(GetCommand);
    expect(sent[0]).toMatchObject({ input: { TableName: 'aggregates', Key: { pk: 'SOURCE_RUN#app_reviews_ios', sk: 'run_1' } } });
  });

  it('queries the newest run when no execution is named, and answers nothing for an empty partition', async () => {
    const { docClient, sent } = client({ Items: [] });
    expect(await readSourceRun(docClient, 'aggregates', 's3_import')).toBeUndefined();
    expect(sent[0]).toBeInstanceOf(QueryCommand);
    expect(sent[0]).toMatchObject({ input: { ScanIndexForward: false, Limit: 1 } });
  });
});
