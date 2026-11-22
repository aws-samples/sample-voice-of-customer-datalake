/**
 * @fileoverview The import wizard's file reading (wizardFile.ts): formats and limits, the detection's sample, RFC 4180
 * parsing with the file's separator, headers named as the server names them, JSON records, the whole file's distinct
 * values and the CSV written for a JSON or workbook file. Made-up data only.
 */
import { describe, expect, it } from 'vitest'
import { textFile } from '@test/textFiles'
import {
  SAMPLE_BYTES, distinctValues, formatOf, headersOf, parseDelimited, pickProblem, readWizardFile, sampleOf, tableOf,
  textSample, toCsv,
} from './wizardFile'
import type { WizardFile } from './wizardFile'

const file = (format: WizardFile['format'], content: string): WizardFile =>
  ({ name: `x.${format}`, format, size: content.length, content, legacyEncoding: false })

describe('formats and limits', () => {
  it('reads a format from the extension', () => {
    expect(['a.CSV', 'b.tsv', 'c.json', 'd.ndjson', 'e.xlsx', 'f.txt', 'g.pdf'].map(formatOf))
      .toStrictEqual(['csv', 'tsv', 'json', 'json', 'xlsx', 'csv', null])
  })

  it('refuses a file it cannot read, an empty one and one too large', () => {
    expect([{ name: 'a.pdf', size: 10 }, { name: 'a.csv', size: 0 }, { name: 'a.xlsx', size: SAMPLE_BYTES + 1 },
            { name: 'a.csv', size: 11 * 1024 * 1024 }, { name: 'a.csv', size: 1024 }].map(pickProblem))
      .toStrictEqual(['format', 'empty', 'workbookTooLarge', 'tooLarge', null])
  })

  it('reads a text file as text and a workbook as base64', async () => {
    expect(await readWizardFile(textFile('a,b\n1,2\n', 'r.csv'))).toStrictEqual(
      { name: 'r.csv', format: 'csv', size: 8, content: 'a,b\n1,2\n', legacyEncoding: false })
    const bytes = new Uint8Array([80, 75, 3, 4])
    const workbook = new File([bytes], 'r.xlsx')
    Object.defineProperty(workbook, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
    expect((await readWizardFile(workbook)).content).toBe('UEsDBA==')
  })
})

/** A picked file of exactly `bytes`. */
function bytesFile(bytes: Uint8Array<ArrayBuffer>, name: string): File {
  const picked = new File([bytes], name)
  Object.defineProperty(picked, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
  return picked
}

describe('the text encoding', () => {
  it('reads UTF-8 strictly, its byte-order mark dropped', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Comentario;Opinión\n')])
    expect(await readWizardFile(bytesFile(bytes, 'utf8.csv'))).toMatchObject(
      { content: 'Comentario;Opinión\n', legacyEncoding: false })
  })

  it('reads a file that is not UTF-8 as Windows-1252, and says so', async () => {
    // "Opinión;Precio €" as a Windows-1252 export writes it: ó is 0xF3 and € 0x80, neither valid UTF-8 there.
    const bytes = new Uint8Array([...new TextEncoder().encode('Opini'), 0xf3, ...new TextEncoder().encode('n;Precio '), 0x80, 0x0a])
    expect(await readWizardFile(bytesFile(bytes, 'legacy.csv'))).toMatchObject(
      { content: 'Opinión;Precio €\n', legacyEncoding: true })
  })
})

describe('the sample', () => {
  it('is the whole of a small file', () => {
    expect(textSample('a\n1\n')).toStrictEqual({ sample: 'a\n1\n', truncated: false })
  })

  it('is cut after the last whole line of a large one', () => {
    const big = `h\n${'x'.repeat(SAMPLE_BYTES)}\n`
    expect(textSample(big)).toStrictEqual({ sample: 'h\n', truncated: true })
  })

  it('keeps the first JSON records that fit', () => {
    const records = Array.from({ length: 3000 }, (_unused, i) => ({ id: i, text: 'y'.repeat(100) }))
    const { sample, truncated } = sampleOf(file('json', JSON.stringify(records)))
    const kept: unknown = JSON.parse(sample)
    expect(truncated).toBe(true)
    expect(new TextEncoder().encode(sample).length).toBeLessThanOrEqual(SAMPLE_BYTES)
    expect(kept).toStrictEqual(records.slice(0, Array.isArray(kept) ? kept.length : 0))
  })

  it('sends a workbook whole', () => {
    expect(sampleOf(file('xlsx', 'UEsDBA=='))).toStrictEqual({ sample: 'UEsDBA==', truncated: false })
  })
})

describe('parsing', () => {
  it('reads quotes, doubled quotes, line ends and blank lines', () => {
    expect(parseDelimited('\uFEFFa,b\r\n"x, ""y""",2\n\n"multi\nline",\n', ',')).toStrictEqual([
      ['a', 'b'], ['x, "y"', '2'], ['multi\nline', '']])
  })

  it('reads semicolons, tabs and pipes', () => {
    expect(parseDelimited('a;b\n"1;2";3', ';')).toStrictEqual([['a', 'b'], ['1;2', '3']])
    expect(parseDelimited('a\tb\n1\t2', '\t')).toStrictEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a|b\n1|2', '|')).toStrictEqual([['a', 'b'], ['1', '2']])
  })

  it('names headers as the server does', () => {
    expect(headersOf([' a ', '', 'a', 7])).toStrictEqual(['a', 'Column 2', 'a (3)', '7'])
  })

  it('reads a delimited file and a workbook as rows', () => {
    expect(tableOf(file('csv', 'a;b\n1;2\n3\n'), ';').rows).toStrictEqual([{ a: '1', b: '2' }, { a: '3', b: '' }])
    expect(tableOf(file('xlsx', ''), ',', { headers: ['a'], rows: [['1'], []] }).rows).toStrictEqual([{ a: '1' }, { a: '' }])
  })

  it('reads a JSON file: an object holding a list, one record per line, nulls', () => {
    expect(tableOf(file('json', '{"items": [{"a": 1, "b": ["x", "y"]}, {"c": true, "d": {"e": 1}}]}'), ',')).toStrictEqual({
      headers: ['a', 'b', 'c', 'd'],
      rows: [{ a: '1', b: 'x; y', c: '', d: '' }, { a: '', b: '', c: 'true', d: '{"e":1}' }]})
    expect(tableOf(file('json', '{"a": 1}\n{"a": 2}\n'), ',').rows).toStrictEqual([{ a: '1' }, { a: '2' }])
    expect(tableOf(file('json', '{"a": null}'), ',').rows).toStrictEqual([{ a: '' }])
  })
})

describe('the whole file', () => {
  const table = { headers: ['Plan', 'Why'], rows: [{ Plan: 'Pro', Why: 'x' }, { Plan: 'pro', Why: 'y' }, { Plan: ' Free ', Why: '' }] }

  it('lists the distinct values of the choice, multiple-choice and matrix columns only', () => {
    expect(distinctValues(table, { Plan: 'choice', Why: 'open_text' })).toStrictEqual({ Plan: ['Pro', 'Free'] })
  })

  it('writes rows back as CSV that parses to the same rows', () => {
    const rows = { headers: ['a', 'b'], rows: [{ a: 'x, "y"', b: 'line\nbreak' }] }
    const text = toCsv(rows)
    expect(text).toBe('a,b\n"x, ""y""","line\nbreak"\n')
    expect(tableOf(file('csv', text), ',')).toStrictEqual(rows)
  })
})
