/**
 * The dev mock's review corpus: fictional reviews for "Acme Outfitters", generated
 * deterministically so the lists agree with the metric fixtures.
 *
 * The metric routes answer static fixtures (1,247 reviews, the per-category counts in
 * `GET /metrics/categories`, the per-category sentiment split, 23 urgent). A list of three
 * hand-written reviews beside them made every page disagree with itself ("1,247 reviews"
 * over a list of 3). `corpusFeedback` returns the reviews that, together with the
 * hand-written ones, add up to those fixtures per category and sentiment, per source
 * (`GET /metrics/sources`) and in the urgent count.
 *
 * Same input, same output: ids, texts, dates and sources come from the index, never from
 * Math.random, so a probe or a screenshot sees the same data on every start.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'];
const SCORE = { positive: 0.72, neutral: 0.02, negative: -0.64, mixed: -0.08 };
const PERSONAS = [
  ['Repeat Customer', 'existing_customer'], ['First-time Buyer', 'prospect'], ['Frustrated Regular', 'churn_risk'],
  ['Brand Fan', 'advocate'], [null, 'unknown'],
];
const CHANNELS = ['review', 'review', 'post', 'ticket'];
/** Reviews are spread over the last WINDOW_DAYS days by import time, at different hours. */
const WINDOW_DAYS = 7;
const HOURS_SPREAD = 11;
/** Days a review may be written before it was imported. */
const WRITTEN_BEFORE_DAYS = 3;

/** What each category's reviews talk about: the subcategories they file under and their phrases. */
const TOPICS = {
  delivery: {
    subcategories: ['late_delivery', 'tracking'],
    negative: ['My order arrived a week after the promised date.', 'The tracking page has not updated in four days.',
      'The parcel was left outside in the rain.', 'Delivery was rescheduled twice without notice.'],
    positive: ['Arrived a day early and well packed.', 'Quick delivery and clear tracking updates.'],
    neutral: ['Delivery took the usual five working days.', 'The courier came in the afternoon as planned.'],
    mixed: ['Fast shipping, but the box was crushed.'],
    problems: { late_delivery: ['Orders arriving after the promised date', 'Deliveries rescheduled without notice'],
      tracking: ['Tracking page not updating'] },
  },
  customer_support: {
    subcategories: ['response_time'],
    negative: ['I waited three days for a reply to a simple question.', 'The chat closed before anyone answered.',
      'Support asked for the same details three times.'],
    positive: ['The agent sorted my exchange in minutes.', 'Friendly support and a quick refund.'],
    neutral: ['Support replied within a day.'],
    mixed: ['Helpful agent, but it took a while to reach one.'],
    problems: { response_time: ['Slow replies from support', 'Chat sessions closing before an answer'] },
  },
  product_quality: {
    subcategories: [],
    negative: ['The zip broke after two weeks.', 'Stitching came apart after the first wash.',
      'The colour faded much faster than expected.'],
    positive: ['Great fabric and it fits true to size.', 'Still looks new after a season of hiking.'],
    neutral: ['The jacket is fine for the price.'],
    mixed: ['Comfortable, but the seams feel weak.'],
    problems: { '': ['Zips breaking within weeks', 'Seams coming apart after washing'] },
  },
  pricing: {
    subcategories: [],
    negative: ['Shipping costs more than the item.', 'The price went up a week after I bought it.'],
    positive: ['Good value during the spring sale.'],
    neutral: ['Prices are similar to other outdoor shops.'],
    mixed: ['Good quality, though a bit expensive.'],
    problems: { '': ['Shipping fees higher than expected'] },
  },
  website: {
    subcategories: [],
    negative: ['Checkout froze when I applied a discount code.', 'The size filter keeps resetting.'],
    positive: ['Easy to find what I needed.'],
    neutral: ['The site works, nothing special.'],
    mixed: ['Nice product pages, slow checkout.'],
    problems: { '': ['Checkout freezing with a discount code'] },
  },
  app: {
    subcategories: [],
    negative: ['The app logs me out every day.', 'Push notifications arrive hours late.'],
    positive: ['The app makes reordering simple.'],
    neutral: ['The app does what the website does.'],
    mixed: ['Handy app, but it crashes on older phones.'],
    problems: { '': ['App signing users out daily'] },
  },
  billing: {
    subcategories: [],
    negative: ['I was charged twice for one order.', 'My refund has not reached my card after two weeks.'],
    positive: ['The invoice was clear and correct.'],
    neutral: ['Payment went through as expected.'],
    mixed: ['Easy payment, but the receipt came late.'],
    problems: { '': ['Duplicate charges for one order'] },
  },
  returns: {
    subcategories: [],
    negative: ['The return label link did not work.', 'It took a month to process my return.'],
    positive: ['Returning the boots was painless.'],
    neutral: ['The return was processed within the stated time.'],
    mixed: ['Easy return, slow refund.'],
    problems: { '': ['Return labels not working'] },
  },
  other: {
    subcategories: [],
    negative: ['The loyalty points disappeared from my account.'],
    positive: ['Love the brand and its repair service.'],
    neutral: ['Saw your stand at the outdoor fair.'],
    mixed: ['Nice store event, but too crowded.'],
    problems: { '': ['Loyalty points missing'] },
  },
};

const pick = (list, index) => list[index % list.length];

function urgencyFor(sentiment, urgent) {
  if (urgent) return 'high';
  return sentiment === 'negative' ? 'medium' : 'low';
}

function ratingFor(sentiment, index) {
  if (sentiment === 'positive') return 5;
  if (sentiment === 'negative') return 1 + (index % 2);
  return 3;
}

/** One generated review; `urgent` is decided by the caller, which holds the quota. */
function reviewAt({ id, category, sentiment, source, urgent, index, now }) {
  const topic = TOPICS[category] ?? TOPICS.other;
  const subcategory = topic.subcategories.length > 0 ? pick(topic.subcategories, index) : undefined;
  const negative = sentiment === 'negative';
  const [personaName, personaType] = pick(PERSONAS, index);
  const processed = now - (index % WINDOW_DAYS) * DAY_MS - (index % HOURS_SPREAD) * HOUR_MS;
  const problemList = topic.problems[subcategory ?? ''];
  const item = {
    feedback_id: String(id),
    source_platform: source,
    source_channel: pick(CHANNELS, index),
    original_text: pick(topic[sentiment], index),
    rating: ratingFor(sentiment, index),
    category,
    sentiment_label: sentiment,
    sentiment_score: SCORE[sentiment],
    urgency: urgencyFor(sentiment, urgent),
    persona_type: personaType,
    source_created_at: new Date(processed - (index % WRITTEN_BEFORE_DAYS) * DAY_MS).toISOString(),
    processed_at: new Date(processed).toISOString(),
  };
  if (subcategory) item.subcategory = subcategory;
  if (personaName) item.persona_name = personaName;
  if (negative && problemList) item.problem_summary = pick(problemList, index);
  return item;
}

/** What is left to generate per category and sentiment once the hand-written reviews are counted. */
function remaining(categorySentiment, handWritten) {
  const left = Object.fromEntries(Object.entries(categorySentiment).map(([category, split]) => [category, { ...split }]));
  for (const item of handWritten) {
    const split = left[item.category];
    if (split && split[item.sentiment_label] > 0) split[item.sentiment_label] -= 1;
  }
  return left;
}

/** One source per generated review, so that with the hand-written ones every source meets its fixture count. */
function sourceSequence(sourceCounts, handWritten, total) {
  const left = { ...sourceCounts };
  for (const item of handWritten) if (left[item.source_platform] > 0) left[item.source_platform] -= 1;
  const sources = Object.keys(left);
  const sequence = [];
  // Round-robin over the sources that still have quota keeps them spread over every category.
  while (sequence.length < total && sources.some((source) => left[source] > 0)) {
    for (const source of sources) {
      if (left[source] > 0 && sequence.length < total) { sequence.push(source); left[source] -= 1; }
    }
  }
  while (sequence.length < total) sequence.push(sources[0]);
  return sequence;
}

/**
 * The generated reviews. `categorySentiment` is the per-category sentiment fixture, `sourceCounts`
 * the per-source fixture, `urgentTotal` the summary's urgent count, `handWritten` the reviews the
 * mock already holds (their ids, categories, sentiments, sources and urgency are counted, not repeated).
 */
export function corpusFeedback({ categorySentiment, sourceCounts, urgentTotal, handWritten, now = Date.now() }) {
  const left = remaining(categorySentiment, handWritten);
  const plan = Object.entries(left).flatMap(([category, split]) =>
    SENTIMENTS.flatMap((sentiment) => Array.from({ length: split[sentiment] ?? 0 }, () => [category, sentiment])));
  const sources = sourceSequence(sourceCounts, handWritten, plan.length);
  const urgentQuota = Math.max(urgentTotal - handWritten.filter((item) => item.urgency === 'high').length, 0);
  // The urgent reviews are spread evenly over the negative ones, so exactly the quota is marked
  // (when there are that many negatives) whatever the fixture holds.
  const negatives = plan.filter(([, sentiment]) => sentiment === 'negative').length;
  const stride = urgentQuota > 0 ? Math.max(Math.floor(negatives / urgentQuota), 1) : Infinity;
  let negativeIndex = 0;
  let urgentLeft = urgentQuota;
  let nextId = handWritten.reduce((max, item) => Math.max(max, Number(item.feedback_id) || 0), 0) + 1;

  return plan.map(([category, sentiment], index) => {
    let urgent = false;
    if (sentiment === 'negative') {
      urgent = urgentLeft > 0 && negativeIndex % stride === 0;
      negativeIndex += 1;
    }
    if (urgent) urgentLeft -= 1;
    return reviewAt({ id: nextId++, category, sentiment, source: sources[index], urgent, index, now });
  });
}
