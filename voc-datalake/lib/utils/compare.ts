/**
 * Comparator for `Array.prototype.sort` that orders strings by UTF-16 code
 * unit — exactly what a bare `.sort()` does — but says so explicitly.
 *
 * Not `localeCompare`: several sorted lists here end up in synthesized
 * templates, the committed baseline or exact-order assertions, and a
 * locale-aware order (case folding, `_` vs letters) would silently reorder
 * them. A named comparator keeps the bare-sort semantics while making the
 * choice visible.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
