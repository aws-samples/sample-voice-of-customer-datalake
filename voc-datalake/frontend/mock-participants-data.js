// Participants mock state (docs/participants.md): fictional people, lists, project links and asks,
// in the lambda/api/engagement_handler.py wire shape. Mutated in place by mock-participants.js for
// the life of the mock process. Fixtures include one unsubscribed person and one ask with mixed
// recipient statuses.

const isoAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

const person = (id, email, name, company, extra = {}) => ({
  person_id: id, email, email_lc: email.toLowerCase(), name, company, title: '', notes: '', tags: [],
  status: 'active', unsubscribed_at: null, origin: 'manual', created_at: isoAgo(30), created_by: 'mock-admin',
  updated_at: isoAgo(30), ...extra,
});

const list = (id, name, kind, description) => ({
  list_id: id, name, description, kind, member_count: 0, created_by: 'mock-admin', created_at: isoAgo(40),
  updated_at: isoAgo(40), feature_request_id: null,
});

export const state = {
  settings: {
    company_domains: ['example.com'], allow_external_people: true, daily_send_cap: 500, sender_name: 'Example Air',
    updated_at: isoAgo(5), updated_by: 'mock-admin',
  },
  /** EMAIL_FROM set in the mock, so the composer can send. */
  emailEnabled: true,
  sentToday: 12,
  people: new Map([
    ['per_ana', person('per_ana', 'ana.lopez@example.com', 'Ana Lopez', 'Example Air', { title: 'Cabin crew lead', tags: ['crew'] })],
    ['per_ben', person('per_ben', 'ben.ito@example.com', 'Ben Ito', 'Example Air', { title: 'Account executive' })],
    ['per_cara', person('per_cara', 'cara.novak@acme.example', 'Cara Novak', 'Acme', { tags: ['beta'] })],
    ['per_dev', person('per_dev', 'dev.shah@acme.example', 'Dev Shah', 'Acme', {
      status: 'unsubscribed', unsubscribed_at: isoAgo(3),
    })],
    ['per_eli', person('per_eli', 'eli.berg@example.com', '', 'Example Air')],
  ]),
  lists: new Map([
    ['lst_staff', list('lst_staff', 'Example Air employees', 'employees', 'Colleagues who test new features first.')],
    ['lst_beta', list('lst_beta', 'Acme beta customers', 'beta', 'Customers in the booking beta.')],
    ['lst_sales', list('lst_sales', 'Sales team', 'sales', '')],
  ]),
  /** list_id → Set of person_id. */
  members: new Map([
    ['lst_staff', new Set(['per_ana', 'per_eli'])],
    ['lst_beta', new Set(['per_cara', 'per_dev'])],
    ['lst_sales', new Set(['per_ben'])],
  ]),
  /** project_id → { lists: Set, people: Set } */
  projects: new Map([['proj_1', { lists: new Set(['lst_beta']), people: new Set(['per_ben']) }]]),
  asks: new Map(),
  /** ask_id → recipient rows */
  recipients: new Map(),
};

const seedAsk = {
  ask_id: 'ask_seed1', project_id: 'proj_1', subject: 'Tell us about the new booking flow',
  message: 'We changed how seats are chosen. Two minutes of your time would help a lot.',
  link: { kind: 'form', form_id: 'form_1', url: 'https://api.example.com/v1/feedback-forms/form_1/iframe' },
  counts: { recipients: 4, sent: 2, failed: 1, skipped: 1, responded: 1 }, status: 'sent',
  created_by: 'mock-admin', created_at: isoAgo(2),
};
state.asks.set(seedAsk.ask_id, seedAsk);
state.recipients.set(seedAsk.ask_id, [
  { person_id: 'per_ben', status: 'responded', sent_at: isoAgo(2), responded_at: isoAgo(1), error: null },
  { person_id: 'per_cara', status: 'sent', sent_at: isoAgo(2), responded_at: null, error: null },
  { person_id: 'per_dev', status: 'skipped_unsubscribed', sent_at: null, responded_at: null, error: null },
  { person_id: 'per_gone', status: 'failed', sent_at: null, responded_at: null, error: 'bounced' },
]);

export function syncMemberCounts() {
  for (const [listId, row] of state.lists) row.member_count = state.members.get(listId)?.size ?? 0;
}
syncMemberCounts();

let counter = 0;
export function newId(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(16)}${counter}`;
}

export const now = () => new Date().toISOString();

/** A person as the API returns it (no email_lc), with the lists they are on. */
export function personView(row) {
  const rest = { ...row };
  delete rest.email_lc;
  const listIds = [...state.members].filter(([, ids]) => ids.has(row.person_id)).map(([listId]) => listId);
  return { ...rest, list_ids: listIds };
}
