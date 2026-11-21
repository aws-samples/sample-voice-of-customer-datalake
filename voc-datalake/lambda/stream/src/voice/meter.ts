/**
 * What a voice session costs, from Nova Sonic's own usage (S-15 findings 6.2): each stream's last `usageEvent`
 * totals (speech and text, in and out), summed over every stream of the session (a rollover opens another), priced
 * per model and region at the AWS Price List's figures, read 2026-11-21 (USD per 1,000 tokens).
 *
 * A region the list has no figure for (ap-northeast-1, read nowhere) is priced at the dearest figure listed for the
 * model, part by part: an estimate errs high, never low. The cost is an estimate for the person's live display and
 * the budget's record; the daily cost rollup prices nothing itself (lambda/shared/model_prices.py).
 */
import type { TokenTotals } from './sonic-events.js';

type Prices = Readonly<TokenTotals>;

const PRICES: Readonly<Record<string, Readonly<Record<string, Prices>>>> = {
  'amazon.nova-2-5-sonic': {
    'us-west-2': { speech_in: 0.0031832, speech_out: 0.0127329, text_in: 0.000319, text_out: 0.002651 },
    'us-east-1': { speech_in: 0.003, speech_out: 0.012, text_in: 0.00033, text_out: 0.00275 },
    'eu-north-1': { speech_in: 0.0033266, speech_out: 0.0133066, text_in: 0.000363, text_out: 0.002992 },
  },
  'amazon.nova-2-sonic-v1:0': {
    'us-west-2': { speech_in: 0.003, speech_out: 0.012, text_in: 0.000319, text_out: 0.002651 },
    'us-east-1': { speech_in: 0.003, speech_out: 0.012, text_in: 0.00033, text_out: 0.00275 },
    'eu-north-1': { speech_in: 0.00291, speech_out: 0.01165, text_in: 0.000363, text_out: 0.002992 },
  },
};

const PARTS = ['speech_in', 'speech_out', 'text_in', 'text_out'] as const;
const ZERO: TokenTotals = { speech_in: 0, speech_out: 0, text_in: 0, text_out: 0 };
/** Micro-dollars per dollar, and per US cent. */
const MICRO = 1_000_000;
const MICRO_PER_CENT = 10_000;
const TOKENS_PER_PRICE = 1000;

/** Each part's dearest figure over `table`'s regions. */
function dearest(table: Readonly<Record<string, Prices>>): Prices {
  const listed = Object.values(table);
  return { ...ZERO, ...Object.fromEntries(PARTS.map((part) => [part, Math.max(0, ...listed.map((one) => one[part]))])) };
}

/** The prices of `modelId` in `region` (the synth allows only the two models listed; any other is priced as 2.5). */
export function pricesFor(modelId: string, region: string): Prices {
  const table = PRICES[modelId] ?? PRICES['amazon.nova-2-5-sonic'] ?? {};
  return table[region] ?? dearest(table);
}

function sum(a: TokenTotals, b: TokenTotals): TokenTotals {
  return { speech_in: a.speech_in + b.speech_in, speech_out: a.speech_out + b.speech_out,
    text_in: a.text_in + b.text_in, text_out: a.text_out + b.text_out };
}

/** The session's usage: the last totals of each of its streams. */
export class Meter {
  private readonly byStream = new Map<number, TokenTotals>();

  constructor(private readonly prices: Prices) {}

  /** A stream's `usageEvent` totals (cumulative for that stream: the last one wins). */
  record(stream: number, totals: TokenTotals): void {
    this.byStream.set(stream, totals);
  }

  tokens(): TokenTotals {
    return [...this.byStream.values()].reduce(sum, ZERO);
  }

  /** The tokens' cost in micro-dollars, rounded. */
  costMicroUsd(): number {
    const tokens = this.tokens();
    return Math.round(PARTS.reduce((total, part) => total + tokens[part] * this.prices[part], 0) * MICRO / TOKENS_PER_PRICE);
  }
}

/** Micro-dollars as US cents, to two decimals (the live display). */
export function centsOf(microUsd: number): number {
  return Math.round(microUsd / MICRO_PER_CENT * 100) / 100;
}
