import assert from 'node:assert/strict';
import { test } from 'node:test';

import { celsiusToFahrenheit, kilometresToMiles } from '../src/convert.js';

test('water freezes at 32 F and boils at 212 F', () => {
  assert.equal(celsiusToFahrenheit(0), 32);
  assert.equal(celsiusToFahrenheit(100), 212);
});

test('-40 is the same on both scales', () => {
  assert.equal(celsiusToFahrenheit(-40), -40);
});

test('kilometres to miles', () => {
  assert.equal(kilometresToMiles(10), 6.21);
});
