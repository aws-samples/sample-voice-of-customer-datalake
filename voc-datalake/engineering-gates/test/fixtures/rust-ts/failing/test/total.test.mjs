import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a total of no votes is zero', () => {
  assert.equal([].reduce((sum, votes) => sum + votes, 0), 0);
});
