import { afterAll, describe, expect, it } from 'vitest';

import { closed, whenListening } from './ws-fixtures.js';

const ENV = {
  VOICE_MODEL_ID: 'amazon.nova-2-5-sonic', VOICE_REGION: 'us-west-2', PROJECTS_TABLE: 'voc-projects',
  AGGREGATES_TABLE: 'voc-aggregates', RAW_DATA_BUCKET: 'voc-raw', PORT: '0',
};

describe('the relay entry point', () => {
  const previous = { ...process.env };
  Object.assign(process.env, ENV);
  const loaded = import('./main.js');

  afterAll(async () => {
    await closed((await loaded).relay);
    process.env = previous;
  });

  it('starts the relay from the runtime\'s environment', async () => {
    const { relay } = await loaded;
    await whenListening(relay);
    expect(relay.listening).toBe(true);
  });
});
