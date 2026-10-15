/**
 * The authored fields of a project's product context, in one place.
 *
 * Two surfaces need to know which fields the *user* fills in: the Product tab,
 * which refuses to start a report when none of them are set, and the Overview
 * card, which reports how complete the description is. A second copy of the
 * field list would be a list that can drift, and the drift would be silent —
 * so both go through here.
 */
import type { ProductContext } from '../../api/types'

/**
 * The only member of `ProductContext` the user does not author. Constrained to
 * `keyof ProductContext`, so renaming the field on the type breaks this line
 * rather than silently turning a server timestamp into "content".
 */
type ServerSetField = Extract<keyof ProductContext, 'updated_at'>

/** A product context with every authored field blank. */
export const emptyProductContext = (): ProductContext => ({
  product_name: '',
  one_liner: '',
  target_users: '',
  problem_solved: '',
  current_state: '',
  key_features: '',
  differentiators: '',
  known_limitations: '',
  non_goals: '',
  success_metrics: '',
  free_form_notes: '',
})

/**
 * The values of every field the user authors.
 *
 * The annotation on the shape below is the point: **leaving a field out is a
 * compile error**, so a field added to `ProductContext` cannot be silently
 * excluded. A plain array of field names would catch a typo but not an omission
 * — and an omission means both the emptiness guard and the completeness count
 * quietly measure the wrong thing.
 *
 * `Required` rather than a bare `Omit`, because `Omit` alone would accept a
 * literal that skips an *optional* member: every authored field is required
 * today, but the guarantee should not quietly depend on that staying true.
 */
function authoredValues(context: ProductContext): string[] {
  const authored: Required<Omit<ProductContext, ServerSetField>> = {
    product_name: context.product_name,
    one_liner: context.one_liner,
    target_users: context.target_users,
    problem_solved: context.problem_solved,
    current_state: context.current_state,
    key_features: context.key_features,
    differentiators: context.differentiators,
    known_limitations: context.known_limitations,
    non_goals: context.non_goals,
    success_metrics: context.success_metrics,
    free_form_notes: context.free_form_notes,
  }
  // `?? ''` is not dead despite the non-nullable annotation: these values come
  // from JSON, where a cleared field can arrive as null, and the spread over
  // emptyProductContext() at the fetch site only fills keys that are *absent*.
  return Object.values(authored).map((value) => value ?? '')
}

/**
 * How many fields a complete description has. Derived from the shape above
 * rather than written down, so the UI cannot promise "of 11" once there are 12.
 */
export const PRODUCT_CONTEXT_FIELD_COUNT = authoredValues(emptyProductContext()).length

/** How many authored fields have content. */
export function countFilledProductContextFields(context: ProductContext): number {
  return authoredValues(context).filter((value) => value.trim() !== '').length
}
