// Two workshop forms made from the Events template (7.63.00) for the dev mock: the same questions and ids
// (template workshop, version 1), so Results › Report › Compare lines them up. "Example Ltd" and "Sample Co" are
// placeholders, never a customer's name.

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
const en = (text) => ({ en: text });
const options = (pairs) => pairs.map(([code, label]) => ({ code, label: en(label) }));
const THEME = { primary_color: '#8e48ff', background_color: '#ffffff', text_color: '#19161d', border_radius: '8px' };
const open = (id, headline) => ({ id, type: 'open_text', required: false, long: true, input_type: 'text', headline: en(headline), placeholder: en('Your answer') });

function eventForm(formId, name, ageDays) {
  return {
    form_id: formId, schema_version: 2, revision: 1, name, enabled: true, language: 'en', languages: ['en'],
    welcome: { enabled: true, title: en('Thanks for joining {{event|the workshop}}'), description: en('A few short questions, about three minutes.') },
    template: { id: 'workshop', version: 1 },
    questions: [
      { id: 'q_role', type: 'single_select', required: true, display: 'list', shuffle: 'none', headline: en("What's your role?"),
        options: options([['product', 'Product'], ['engineering', 'Engineering'], ['qa', 'QA'], ['design', 'Design']]),
        other: { enabled: true, label: en('Something else') }, none: { enabled: false } },
      { id: 'q_value', type: 'rating', required: true, scale: 'star', range: 5, headline: en('How valuable was {{event|the workshop}} for your work?') },
      { id: 'q_phases', type: 'matrix', required: false, shuffle_rows: false, display: 'auto', headline: en('How effective was each part?'),
        rows: options([['introduction', 'Introduction'], ['demo', 'Demonstration'], ['hands_on', 'Hands-on exercises'], ['wrap_up', 'Wrap-up and Q&A']]),
        columns: [{ code: 'needs_improvement', label: en('Needs improvement'), score: 1 }, { code: 'satisfactory', label: en('Satisfactory'), score: 2 },
          { code: 'very_effective', label: en('Very effective'), score: 3 }, { code: 'exceptional', label: en('Exceptional'), score: 4 }] },
      { id: 'q_tooling', type: 'rating', required: true, scale: 'number', range: 5, headline: en('How well did the tools and setup work for you?'),
        logic: [{ when: { op: 'gt', value: 2 }, then: { jump_to: 'q_nps' } }] },
      open('q_tooling_why', 'You rated the tools {{q_tooling}}. What got in the way?'),
      { id: 'q_nps', type: 'nps', required: true, headline: en('How likely are you to recommend {{event|this workshop}} to a colleague?') },
      open('q_nps_reason', "What's the main reason for your score of {{q_nps}}?"),
      open('q_takeaway', "What's your main takeaway?"),
    ],
    hidden_fields: [{ id: 'customer', label: 'Customer' }, { id: 'event', label: 'Event' }, { id: 'event_date', label: 'Event date' },
      { id: 'presenter', label: 'Presenter' }],
    endings: [{ id: 'end_thanks', title: en('Thank you!'), description: en('Your feedback helps us make the next session better.') }],
    settings: { test: { link_enabled: false, record: 'tag' } }, theme: { ...THEME }, category: '', subcategory: '', project_id: '',
    document_id: '', custom_fields: [], dimension_defaults: {}, tags: ['workshop'], form_type: 'standard',
    updated_by: 'ana@example.com', created_at: daysAgo(ageDays), updated_at: daysAgo(ageDays),
  };
}

export const EVENT_FORMS = [eventForm('fv2_event_a', 'Example Ltd workshop', 20), eventForm('fv2_event_b', 'Sample Co workshop', 9)];

const COLUMNS = ['needs_improvement', 'satisfactory', 'very_effective', 'exceptional'];
const ROLES = ['product', 'engineering', 'engineering', 'qa', 'design'];
const TAKEAWAYS = ['The hands-on labs made it click', 'Pairing on real tickets was the best part', 'I want more time for the labs',
  'The demo moved too fast', 'Clear structure, good examples', ''];
const THEMES = [['content', 'labs'], ['content', 'pace'], ['presenter', '']];

/** The processing's sentiment as the mock gives it: a promoter's positive, a detractor's negative. */
function sentimentOf(nps) {
  if (nps >= 9) return 'positive';
  return nps <= 6 ? 'negative' : 'neutral';
}

/** One response to an event form: a low tooling score gets its "why", the date and customer from the link. */
function eventResponse(random, formId, customer, index, dates) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const tooling = 1 + Math.floor(random() * 5);
  const nps = Math.min(10, 4 + Math.floor(random() * 7));
  const answers = {
    q_role: { code: pick(ROLES) }, q_value: 3 + Math.floor(random() * 3),
    q_phases: { rows: { introduction: pick(COLUMNS), demo: pick(COLUMNS), hands_on: COLUMNS[2 + Math.floor(random() * 2)] } },
    q_tooling: tooling, q_nps: nps,
  };
  if (tooling <= 2) answers.q_tooling_why = pick(['The VPN kept dropping', 'Accounts were not ready', 'Laptop setup took half an hour']);
  if (random() > 0.3) answers.q_nps_reason = nps >= 9 ? 'Practical and well paced' : 'Good, but too much in one day';
  const takeaway = pick(TAKEAWAYS);
  if (takeaway !== '') answers.q_takeaway = takeaway;
  const [category, subcategory] = pick(THEMES);
  return {
    response_id: `resp_${formId}_${index}`, feedback_id: `fb_${formId}_${index}`, submitted_at: daysAgo(dates[index % dates.length] - index * 0.01),
    form_revision: 1, language: 'en', answers, ending_id: 'end_thanks', is_test: false, channel: 'link',
    hidden: { customer, event: `${customer} workshop`, event_date: new Date(Date.now() - dates[index % dates.length] * DAY_MS).toISOString().slice(0, 10),
      presenter: 'Dana' },
    shown: ['q_role', 'q_value', 'q_phases', 'q_tooling', ...(tooling <= 2 ? ['q_tooling_why'] : []), 'q_nps', 'q_nps_reason', 'q_takeaway'],
    sentiment: sentimentOf(nps), category, subcategory,
  };
}

/** The event forms' stored responses, newest first: 14 for Example Ltd over two sessions, 8 for Sample Co. */
export function eventResponses(generator) {
  const random = generator(763);
  const a = Array.from({ length: 14 }, (_unused, index) => eventResponse(random, 'fv2_event_a', 'Example Ltd', index, [19, 12]));
  const b = Array.from({ length: 8 }, (_unused, index) => eventResponse(random, 'fv2_event_b', 'Sample Co', index, [8]));
  const newest = (rows) => rows.sort((x, y) => y.submitted_at.localeCompare(x.submitted_at));
  return [['fv2_event_a', newest(a)], ['fv2_event_b', newest(b)]];
}
