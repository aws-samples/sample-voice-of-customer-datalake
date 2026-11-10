// The change stamp every in-place feedback edit writes, like the API's `ManualEdit`
// (lambda/shared/feedback_category.py `manual_edit_fields`): who (`updated_by {sub, kind}`), when
// (`updated_at`) and why (`change_reason`, the values of shared/silver_provenance.py). The Data Explorer
// editor sends `updated_at` back and is refused (409) once another edit moved it, so every mock edit route
// stamps it too. The Silver copy the API keeps has no mock counterpart.

export const REASON_CATEGORY_EDIT = 'category_edit';
export const REASON_DIMENSIONS_EDIT = 'dimensions_edit';
export const REASON_DATA_EXPLORER_EDIT = 'data_explorer_edit';

/** Stamps `item` (mutated) as edited now by the mock admin for `reason`. */
export function stampManualEdit(item, reason) {
  item.updated_at = new Date().toISOString();
  item.updated_by = { sub: 'mock-admin', kind: 'admin' };
  item.change_reason = reason;
}
