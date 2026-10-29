/**
 * Write fingerprint: sha256 hex of `canonicalWriteText(tool, args)`, recorded on
 * a plan step before its write runs. Byte-identical to
 * `lambda/shared/plan_schema.py::canonical_write_fingerprint` (pinned by the
 * shared fixture `lambda/shared/test/fixtures/plan-fingerprints.json`).
 */
import { createHash } from 'node:crypto';
import { canonicalWriteText } from './canonical.js';

export function canonicalWriteFingerprint(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalWriteText(tool, args), 'utf8').digest('hex');
}
