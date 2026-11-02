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

const { STRING, NUMBER, BOOLEAN, NULL, OBJECT } = apigateway.JsonSchemaType;
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
} as const;

/** A field the handler lets be absent or null, else a string of at most `maxLength` characters. */
const optionalString = (maxLength: number): apigateway.JsonSchema => ({ type: [STRING, NULL], maxLength });

const formBounds = FEEDBACK_SUBMISSION_BOUNDS;

/** `POST /feedback-forms/{form_id}/submit`: `_validated_submission` + `_widget_dimensions`. */
const feedbackFormSubmission: apigateway.JsonSchema = {
  schema: DRAFT4,
  title: 'FeedbackFormSubmission',
  type: OBJECT,
  // Absent, null or blank text is "Feedback text is required" (400) in the handler.
  required: ['text'],
  properties: {
    text: { type: STRING, minLength: 1 },
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
  BallotSubmission: ballotSubmission,
} as const;

export type PublicBodyModelName = keyof typeof PUBLIC_BODY_MODELS;
