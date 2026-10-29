/**
 * @fileoverview The value half of a Recharts tooltip row, in the reader's language.
 *
 * A series without a `name` shows its data key ("value : 3", 5.34.00), so every
 * chart names its series; this formatter then writes the value the reader's way:
 * a count with the locale's grouping ("1,234" / "1.234"), an average sentiment
 * signed with two decimals ("−0.42"), the series name unchanged.
 *
 * @module pages/Dashboard/chartTooltip
 */
import { signedAverage } from '../../components/SentimentWords/sentimentWords'
import { formatCount } from '../../utils/numberFormat'

/** Recharts' `formatter` for series of counts and, named in `sentimentSeries`, average sentiments. */
export function tooltipFormatter(language: string, sentimentSeries: readonly string[] = []) {
  return (value: unknown, name: unknown): [string, string] => {
    const series = String(name)
    if (typeof value !== 'number') return [String(value), series]
    return [sentimentSeries.includes(series) ? signedAverage(value, language) : formatCount(value, language), series]
  }
}
