// The built-in `feedback_type` dimension for the dev mock, in the wire shape of
// lambda/shared/feedback_types.py (`feedback_type_dimension()`): defined in code,
// listed first by GET /settings/dimensions with `builtin: true`, never stored by a PUT.
// Not a route module: mock-dimensions.js puts it in its dimensions list and stamps
// fixture feedback with a type (every 5th item stays untyped, as before a backfill).

const FEEDBACK_TYPE_KEY = 'feedback_type';

const TYPES = [
  ['bug', 'Bug', 'Something is broken or wrong: an error, a crash, wrong data'],
  ['service_failure', 'Service failure', 'The service did not deliver: an outage, a failed delivery or payment, cannot log in'],
  ['feature_request', 'Feature request', 'Asks for something new or for a change'],
  ['usability', 'Usability', 'Works, but is confusing or hard to use'],
  ['performance', 'Performance', 'Works, but is slow (a crash is a bug)'],
  ['pricing_billing', 'Pricing and billing', 'Prices, fees, charges, refunds, invoices'],
  ['support_experience', 'Support experience', 'How customer support or staff handled the customer'],
  ['praise', 'Praise', 'Positive feedback with no problem to fix'],
  ['question', 'Question', 'Asks how something works'],
  ['other', 'Other', 'None of the above'],
];

/** A fresh copy of the built-in dimension. */
export function feedbackTypeDimension() {
  return {
    key: FEEDBACK_TYPE_KEY,
    label: 'Feedback type',
    description: 'The ONE primary type of the feedback.',
    infer: true,
    builtin: true,
    values: TYPES.map(([name, label, description]) => ({ name, label, description })),
  };
}

/** Whether a dimension entry uses a built-in key (a PUT drops it, like validate_dimensions). */
export const isBuiltinDimension = (dimension) => dimension?.key === FEEDBACK_TYPE_KEY;

// Every UNTYPED_EVERY-th fixture item is left untyped ("N reviews not typed yet").
const UNTYPED_EVERY = 5;

// Positive reviews read as praise; the rest cycle through the problem and request types.
const NON_PRAISE = ['bug', 'service_failure', 'usability', 'feature_request', 'performance', 'pricing_billing', 'support_experience', 'question'];

/** Stamp a type on the fixture feedback that has none (inferred by "the model": source `ai`). */
export function stampFeedbackTypes(feedback) {
  feedback.forEach((item, index) => {
    if (index % UNTYPED_EVERY === UNTYPED_EVERY - 1 || (item.dimensions || {})[FEEDBACK_TYPE_KEY]) return;
    const type = item.sentiment_label === 'positive' ? 'praise' : NON_PRAISE[index % NON_PRAISE.length];
    item.dimensions = { ...(item.dimensions || {}), [FEEDBACK_TYPE_KEY]: type };
    item.dimension_sources = { ...(item.dimension_sources || {}), [FEEDBACK_TYPE_KEY]: 'ai' };
  });
}
