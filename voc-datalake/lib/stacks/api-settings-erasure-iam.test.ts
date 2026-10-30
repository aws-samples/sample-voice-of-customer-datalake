/**
 * The Settings API's grants for whole-source erasure (5.53.00, lambda/shared/source_erasure.py):
 * `GET` and `POST /settings/erasure` list the counted sources by querying voc-aggregates'
 * `gsi1-by-metric-type` index, and `POST` writes the source's lock row. moto does not enforce IAM,
 * so this pins that the role may Query the aggregates table's indexes (a grant on the table ARN
 * alone would answer AccessDenied on the index in a real deployment), and that the role still
 * holds no delete on the feedback table (the worker, voc-retention, deletes).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { apiTemplate, policyStatementsOf } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const ROLE = 'SettingsLambdaRole';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const statements = () => policyStatementsOf(apiTemplate(), `${ROLE}DefaultPolicy`);

describe('Settings role: whole-source erasure', () => {
  it('may Query and write the aggregates table, its indexes included', () => {
    const onAggregates = statements().filter((s) => /aggregates/i.test(s.resource));
    const query = onAggregates.filter((s) => s.actions.includes('dynamodb:Query'));
    expect(query.some((s) => s.resource.includes('/index/*'))).toBe(true);
    const writes = onAggregates.filter((s) => s.actions.includes('dynamodb:PutItem') && s.actions.includes('dynamodb:UpdateItem'));
    expect(writes.length).toBeGreaterThan(0);
  });

  it('holds no delete on the feedback table', () => {
    const feedbackDeletes = statements()
      .filter((s) => /feedback/i.test(s.resource) && !/aggregates/i.test(s.resource))
      .filter((s) => s.actions.some((a) => a === 'dynamodb:DeleteItem' || a === 'dynamodb:BatchWriteItem' || a === 'dynamodb:*'));
    expect(feedbackDeletes).toStrictEqual([]);
  });
});
