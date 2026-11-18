/**
 * The JSON-schema request models of the PUBLIC (unauthenticated) write routes (api-request-validation.ts).
 *
 * API Gateway models are JSON Schema draft 4
 * (https://docs.aws.amazon.com/apigateway/latest/developerguide/models-mappings-models.html). Each model
 * mirrors what its handler ACCEPTS today, and is never stricter: a body the handler takes must pass, or a
 * legitimate client (the embeddable widget, the prototype pin widget, the ballot page) breaks with a gateway 400. Where the handler cannot be mirrored exactly the model
 * is LOOSER and the handler keeps the last word:
 *
 *  - Extra fields are allowed everywhere (no `additionalProperties: false` at the top level): the handlers
 *    ignore them, the widget sends `participant_token`, a pin sends `pin`.
 *  - A bound the handler checks AFTER stripping (`text`, a ballot's `notes`) has no `maxLength`: a padded
 *    body the handler accepts would fail one.
 *  - Values the handler clamps or truncates rather than refuses (ballot axes, `display_name`, `ballot_id`)
 *    and the ballot axes themselves (a workspace setting read per request) are not modelled.
 *  - A `custom_fields` key length is not modelled: draft 4 has no `propertyNames`, and a `{1,64}` regex in
 *    `patternProperties` (ECMA 262) counts UTF-16 units where the handler counts code points. Only the empty
 *    key, which the handler refuses, is refused here too.
 *
 * Every bound below is lockstepped with the Python constant of the same name by api-request-models.test.ts.
 */
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

const { STRING, NUMBER, INTEGER, BOOLEAN, NULL, OBJECT } = apigateway.JsonSchemaType;
const DRAFT4 = apigateway.JsonSchemaVersion.DRAFT4;

/** lambda/api/feedback_form_handler.py: the public submission bounds (issue #222). */
export const FEEDBACK_SUBMISSION_BOUNDS = {
  MAX_SUBMISSION_RATING: 10,
  MAX_SUBMITTER_NAME_CHARS: 200,
  MAX_SUBMITTER_EMAIL_CHARS: 254,
  MAX_PAGE_URL_CHARS: 4096,
  MAX_CUSTOM_FIELDS: 20,
  MAX_CUSTOM_FIELD_VALUE_CHARS: 1000,
  MAX_WIDGET_DIMENSIONS: 10,
  // Schema version 2 (lambda/shared/forms_v2.py MAX_QUESTIONS, MAX_HIDDEN_FIELDS; forms_v2_responses.py).
  MAX_FORM_ANSWERS: 30,
  MAX_HIDDEN_FIELDS: 20,
  MAX_TEST_TOKEN_CHARS: 64,
  MAX_FORM_ID_CHARS: 44,
  // The route id bound (`_validated_form_id`), restated for the body's `form_id`.
  FORM_ID_MAX_LENGTH: 64,
} as const;

/** A field the handler lets be absent or null, else a string of at most `maxLength` characters. */
const optionalString = (maxLength: number): apigateway.JsonSchema => ({ type: [STRING, NULL], maxLength });

const formBounds = FEEDBACK_SUBMISSION_BOUNDS;
/** lambda/shared/forms_v2.py QUESTION_ID / HIDDEN_ID and the beacon's session (feedback_form_handler.py _SESSION). */
const QUESTION_ID = '^q_[a-z0-9_]{1,40}$';
const HIDDEN_ID = '^[a-z][a-z0-9_]{0,39}$';
const SESSION_ID = '^[A-Za-z0-9_-]{8,64}$';
/** lambda/shared/forms_v2.py FORM_LOCALES. */
const FORM_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl'];

/** `POST /feedback-forms/{form_id}/submit`: `_validated_submission` + `_widget_dimensions`. */
const feedbackFormSubmission: apigateway.JsonSchema = {
  schema: DRAFT4,
  title: 'FeedbackFormSubmission',
  type: OBJECT,
  // No field is required: a version 1 body's absent, null or blank `text` is "Feedback text is required" (400) in
  // the handler; a version 2 response (schema v2, 7.55.00) sends `answers` instead, and a beacon `event`.
  properties: {
    text: { type: STRING, minLength: 1 },
    // A version 2 response (lambda/shared/forms_v2_responses.py check_envelope): its answers keyed by question id
    // (no other key: an id is `q_…`), its hidden values keyed by hidden-field id, the revision it answered, its
    // language, the ending its logic reached and the form's id. The handler checks every value against the form's
    // revision; a hidden value's length is checked there too, after it is trimmed.
    answers: {
      type: OBJECT, maxProperties: formBounds.MAX_FORM_ANSWERS,
      patternProperties: { [QUESTION_ID]: {} }, additionalProperties: false,
    },
    hidden: {
      type: [OBJECT, NULL], maxProperties: formBounds.MAX_HIDDEN_FIELDS,
      patternProperties: { [HIDDEN_ID]: { type: [STRING, NULL] } }, additionalProperties: false,
    },
    form_revision: { type: [INTEGER, NULL], minimum: 1 },
    language: { type: [STRING, NULL], enum: [...FORM_LOCALES, null] },
    ending_id: optionalString(formBounds.MAX_FORM_ID_CHARS),
    // The widget's random id of the visit (closes the funnel's dedupe row of its `left`): no person's data.
    session: { type: [STRING, NULL], pattern: SESSION_ID },
    form_id: optionalString(formBounds.FORM_ID_MAX_LENGTH),
    // The form's test token (the test link's `test=`), checked against the form by the handler.
    test: optionalString(formBounds.MAX_TEST_TOKEN_CHARS),
    // Absent, null, or a finite number in 1..MAX_SUBMISSION_RATING; a boolean is not a draft-4 number.
    rating: { type: [NUMBER, NULL], minimum: 1, maximum: formBounds.MAX_SUBMISSION_RATING },
    name: optionalString(formBounds.MAX_SUBMITTER_NAME_CHARS),
    email: optionalString(formBounds.MAX_SUBMITTER_EMAIL_CHARS),
    page_url: optionalString(formBounds.MAX_PAGE_URL_CHARS),
    custom_fields: {
      type: [OBJECT, NULL],
      maxProperties: formBounds.MAX_CUSTOM_FIELDS,
      patternProperties: { '^$': { not: {} } },
      // Each answer a short scalar: string, finite number, boolean or null.
      additionalProperties: { type: [STRING, NUMBER, BOOLEAN, NULL], maxLength: formBounds.MAX_CUSTOM_FIELD_VALUE_CHARS },
    },
    // Malformed entries are dropped by the handler; only the shape and the count are refused.
    dimensions: { type: [OBJECT, NULL], maxProperties: formBounds.MAX_WIDGET_DIMENSIONS },
  },
};

/** `POST /feedback-forms/{form_id}/events`: the widget's funnel beacons (`_validated_event`, 7.55.00). STRICT, unlike
 *  the submission: no older widget sends anything else here, so an unknown field is refused at the gateway. The
 *  handler also requires `question_id` on a `left` and refuses it on an `opened`: draft 4 says that only with a
 *  `oneOf`, so the event stays one shape, looser there (test_public_body_models_parity.py lists both cases). The
 *  widget sends it with navigator.sendBeacon as text/plain, which this `application/json` model does not judge
 *  (api-request-validation.ts): the handler checks every field before any read. */
const feedbackFormEvent: apigateway.JsonSchema = {
  schema: DRAFT4,
  title: 'FeedbackFormEvent',
  type: OBJECT,
  required: ['event'],
  additionalProperties: false,
  properties: {
    event: {
      type: OBJECT, required: ['kind', 'session'], additionalProperties: false,
      properties: {
        kind: { type: STRING, enum: ['left', 'opened'] },
        question_id: { type: STRING, pattern: QUESTION_ID },
        session: { type: STRING, pattern: SESSION_ID },
        revision: { type: INTEGER, minimum: 1 },
      },
    },
    // The form's test token (the test link's `test=`), checked against the form by the handler.
    test: optionalString(formBounds.MAX_TEST_TOKEN_CHARS),
  },
};

/** `POST /voting-sessions/{session_id}/submit`: `json_object_body` + `_validated_note`. */
const ballotSubmission: apigateway.JsonSchema = {
  schema: DRAFT4,
  title: 'BallotSubmission',
  type: OBJECT,
  properties: { notes: { type: [STRING, NULL] } },
};

/** The model of each validated route, by the API Gateway model name it is created under. */
export const PUBLIC_BODY_MODELS = {
  FeedbackFormSubmission: feedbackFormSubmission,
  FeedbackFormEvent: feedbackFormEvent,
  BallotSubmission: ballotSubmission,
} as const;

export type PublicBodyModelName = keyof typeof PUBLIC_BODY_MODELS;
