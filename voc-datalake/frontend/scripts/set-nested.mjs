/**
 * Prototype-safe nested setter for locale objects.
 *
 * Extracted from fix-i18n.mjs so tests can exercise the real helper without
 * importing that script (its main loop runs at import time and would trigger
 * Bedrock translation calls).
 *
 * Two complementary protections:
 *
 * 1. Structural: intermediate containers are created with Object.create(null),
 *    so there is no prototype to pollute no matter what key reaches them.
 *    JSON.stringify serializes own enumerable properties only, so files saved
 *    by saveJSON are byte-identical to containers built with `{}` literals.
 *
 * 2. Denylist (kept as defence in depth): segments named `__proto__`,
 *    `constructor` or `prototype` are rejected before any write. This layer is
 *    load-bearing for prototypal roots: with a plain root object, a leading
 *    `__proto__` segment resolves through the accessor on Object.prototype and
 *    would reach it even when every created container is null-prototypal.
 */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function setNested(obj, key, val) {
  const parts = key.split('.')
  if (parts.some(p => UNSAFE_KEYS.has(p))) return
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = Object.create(null)
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = val
}
