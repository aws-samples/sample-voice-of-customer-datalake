/**
 * The guided product interview: the ONE place its questions live.
 *
 * The Product tab's "Fill with AI assistant" button opens a new conversation with a
 * short request to be interviewed; this guidance (part of the cached system prompt
 * whenever `update_product_context` is offered) turns that request into a guided
 * interview — one question per message, only for the fields still empty — that
 * ends in ONE `update_product_context` approval card. Nothing is saved without it.
 *
 * Every product-context field (`lambda/api/product_context.py` STRING_FIELDS +
 * `current_state`) has exactly one question; `product-interview.test.ts` pins that.
 */
import { LIFECYCLE_STATES, type PRODUCT_CONTEXT_STRING_FIELDS } from './client/allowlists.js';

type ProductContextField = keyof typeof PRODUCT_CONTEXT_STRING_FIELDS | 'current_state';

interface InterviewQuestion {
  readonly field: ProductContextField;
  readonly question: string;
}

/** In the order they are asked. */
export const PRODUCT_INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  { field: 'product_name', question: 'What is the product or service called?' },
  { field: 'one_liner', question: 'In one sentence, what does it do and for whom?' },
  { field: 'target_users', question: 'Who are its target customers or users?' },
  { field: 'problem_solved', question: 'What problem does it solve for them?' },
  {
    field: 'current_state',
    question: `Where is it in its lifecycle: an idea, an MVP, in beta, generally available or mature? (one of ${LIFECYCLE_STATES.join(', ')})`,
  },
  { field: 'key_features', question: 'What are its key features?' },
  { field: 'differentiators', question: 'Which competitors or alternatives do customers compare it with, and how is it different?' },
  { field: 'success_metrics', question: 'What are its goals, and which metrics show success?' },
  { field: 'known_limitations', question: 'Which constraints or known limitations does it have?' },
  { field: 'non_goals', question: 'What is deliberately out of scope (non-goals)?' },
  { field: 'free_form_notes', question: 'Anything else the PRD and PR/FAQ writers should know?' },
];

export const PRODUCT_INTERVIEW_GUIDANCE = [
  '- Product interview: when the user asks you to interview them about the product or to fill in the product '
    + 'description (the Product tab\u2019s "Fill with AI assistant" button sends that request): (1) get_product_context, '
    + 'then ask ONLY about the fields that are still empty, ONE question per message, in the order below, in the '
    + 'user\u2019s language; (2) do not propose a write between questions; "skip" or "I don\u2019t know" leaves the field '
    + 'out, and never invent an answer; (3) after the last question, summarise the answers and propose ONE '
    + 'update_product_context with every answered field as clear final text (current_state as its listed value). '
    + 'When every field is already filled, say so and offer to revise one.',
  ...PRODUCT_INTERVIEW_QUESTIONS.map(({ field, question }) => `  - ${field}: ${question}`),
].join('\n');
