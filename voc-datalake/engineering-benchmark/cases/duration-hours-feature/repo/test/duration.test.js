import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDuration } from '../src/duration.js';

test('seconds alone', () => {
  assert.equal(formatDuration(45), '45s');
});

test('minutes and seconds', () => {
  assert.equal(formatDuration(125), '2m 5s');
});

test('a negative or fractional number is refused', () => {
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(1.5), RangeError);
});

test('an hour or more shows hours first', () => {
  assert.equal(formatDuration(3725), '1h 2m 5s');
  assert.equal(formatDuration(7200), '2h 0m 0s');
});

test('just under an hour stays in minutes', () => {
  assert.equal(formatDuration(3599), '59m 59s');
});
