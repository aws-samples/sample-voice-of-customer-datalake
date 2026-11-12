/**
 * Multi-workspace (docs/multi-workspace.md): gsi4 and gsi5 of voc-feedback are keyed on their own attributes,
 * `gsi4pk` (`FEEDBACK#{id}`, a workspace's `WS#{ws}#FEEDBACK#{id}`) and `gsi5pk` (`CHANNEL#{channel}`), never on the
 * raw `feedback_id` and `source_channel`, which hold the same value in every workspace: a deployment-wide read by
 * id or channel then never finds a workspace's item (lambda/shared/feedback_partitions.py). The index names and
 * projections stay (lambda/shared/indexes.py), gsi5 projecting `source_channel` now that it is no key.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt, recordAt } from '../test-support/guards';
import { byCodeUnit } from '../utils/compare';

const IndexesSchema = z.array(z.object({
  IndexName: z.string(),
  KeySchema: z.array(z.object({ AttributeName: z.string(), KeyType: z.string() })),
  Projection: z.object({ ProjectionType: z.string(), NonKeyAttributes: z.array(z.string()).optional() }),
}));
const DefinitionsSchema = z.array(z.object({ AttributeName: z.string(), AttributeType: z.string() }));

function feedbackIndexes() {
  const entries = Object.entries(synthCoreTemplate().findResources('AWS::DynamoDB::Table'))
    .filter(([logicalId]) => logicalId.startsWith('FeedbackTable'));
  expect(entries).toHaveLength(1);
  const properties = recordAt(itemAt(entries, 0)[1], 'Properties');
  const indexes = IndexesSchema.parse(properties?.GlobalSecondaryIndexes);
  const definitions = DefinitionsSchema.parse(properties?.AttributeDefinitions);
  return { byName: new Map(indexes.map((index) => [index.IndexName, index])), definitions };
}

describe('voc-feedback indexes by id and by channel', () => {
  it('keys gsi4 on gsi4pk, projecting every attribute', () => {
    const gsi4 = feedbackIndexes().byName.get('gsi4-by-feedback-id');
    expect(gsi4?.KeySchema).toStrictEqual([{ AttributeName: 'gsi4pk', KeyType: 'HASH' }]);
    expect(gsi4?.Projection).toStrictEqual({ ProjectionType: 'ALL' });
  });

  it('keys gsi5 on gsi5pk and gsi1sk, projecting the channel itself', () => {
    const gsi5 = feedbackIndexes().byName.get('gsi5-by-channel');
    expect(gsi5?.KeySchema).toStrictEqual([
      { AttributeName: 'gsi5pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
    ]);
    expect(gsi5?.Projection.ProjectionType).toBe('INCLUDE');
    expect(gsi5?.Projection.NonKeyAttributes).toContain('source_channel');
  });

  it('keys no index on an attribute that is the same in every workspace', () => {
    const { byName, definitions } = feedbackIndexes();
    const keys = [...byName.values()].flatMap((index) => index.KeySchema.map((key) => key.AttributeName));
    const defined = definitions.map((definition) => definition.AttributeName);
    for (const shared of ['feedback_id', 'source_channel']) {
      expect(keys).not.toContain(shared);
      expect(defined).not.toContain(shared);
    }
    expect([...byName.keys()].sort(byCodeUnit)).toStrictEqual([
      'gsi1-by-date', 'gsi2-by-category', 'gsi3-by-urgency', 'gsi4-by-feedback-id', 'gsi5-by-channel',
    ]);
  });
});
