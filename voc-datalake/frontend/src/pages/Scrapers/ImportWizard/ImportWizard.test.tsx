/**
 * @fileoverview The import wizard end to end against a routed `fetchApi` (7.67.00, docs/import-wizard.md): a reviews
 * file goes through the CSV import with the wizard's mapping and its tag; a survey export becomes an imported form
 * (off, `imported`) and its rows are imported with the original file, a failed call resumed into the same form; a
 * kind can be changed and a personal-data column is flagged; a file that is not UTF-8 is read as Windows-1252 with a
 * warning, and one it cannot read is refused in words. First insights' reads are their own spec. Made-up data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { pageFileInput, textFile } from '@test/textFiles'
import { isRecord } from '../../../lib/typeGuards'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import ImportWizard from './ImportWizard'

vi.mock('../../../hooks/useDimensions', () => ({
  useDimensionsConfig: () => ({ data: { dimensions: [{ key: 'product', label: 'Product', infer: false, values: [] }] } }),
  useSourceProfiles: () => ({ data: [] }),
}))
vi.mock('../../../hooks/useCategories', () => ({
  useCategoriesConfig: () => ({ data: { categories: [{ name: 'customer_support', description: 'Support desk' }] } }),
}))
const mockAfterIngest = vi.fn()
vi.mock('../../../api/invalidateFeedbackData', () => ({ useInvalidateFeedbackData: () => mockAfterIngest }))
const importRight = { allowed: true }
vi.mock('./useCanImport', () => ({ useCanImport: () => importRight.allowed }))
const READY = { processed: 2, ready: true, slow: false, alreadyImported: false, stillProcessing: false,
  sentiment: { positive: 50, negative: 50 }, categories: [['customer_support', 2], ['delivery_speed', 1]],
  quotes: [{ id: 'f1', text: 'Fast delivery' }], nps: 20 }
const insights = { now: READY }
vi.mock('./useFirstInsights', () => ({ useFirstInsights: () => insights.now }))

const REVIEWS = 'Comment;Product;Stars;Email\nFast delivery;App;5;ana@example.com\nLogin fails;Web;1;bo@example.com\n'
const SURVEY = 'Response ID,Recommend us?,Plan\nr1,9,Pro\nr2,6,Free\n'

function column(header: string, kind: string, extra: Record<string, unknown> = {}) {
  return { header, kind, confidence: 0.9, reasons: [{ code: 'header_says', params: { word: header.toLowerCase() } }],
           reason: '', personal: kind === 'email', values: [], filled: 2, ...extra }
}

const REVIEWS_ANSWER = {
  format: 'csv', delimiter: ';', headers: ['Comment', 'Product', 'Stars', 'Email'], row_count: 2,
  columns: [column('Comment', 'open_text'), column('Product', 'choice', { values: ['App', 'Web'] }),
            column('Stars', 'rating_1_5', { confidence: 0.6 }), column('Email', 'email')],
  suggested: { target: 'reviews', mapping: { Comment: 'open_text', Product: 'choice', Stars: 'rating_1_5', Email: 'email' },
               date_order: 'dmy', form: null, form_problem: null },
}
const DEFINITION = {
  language: 'en', questions: [
    { id: 'q_recommend_us', type: 'nps', headline: { en: 'Recommend us?' }, required: false },
    { id: 'q_plan', type: 'single_select', headline: { en: 'Plan' }, required: false,
      options: [{ code: 'pro', label: { en: 'Pro' } }, { code: 'free', label: { en: 'Free' } }] }],
  endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }],
}
const SURVEY_ANSWER = {
  format: 'csv', delimiter: ',', headers: ['Response ID', 'Recommend us?', 'Plan'], row_count: 2,
  columns: [column('Response ID', 'id'), column('Recommend us?', 'nps_0_10'), column('Plan', 'choice', { values: ['Pro', 'Free'] })],
  suggested: { target: 'survey', mapping: { 'Response ID': 'id', 'Recommend us?': 'nps_0_10', Plan: 'choice' }, date_order: 'dmy',
               form: { definition: DEFINITION, mapping: { 'Response ID': 'id', 'Recommend us?': 'q_recommend_us', Plan: 'q_plan' },
                       problems: [] }, form_problem: null },
}

const csvFile = textFile
const fileInput = pageFileInput

async function upload(content: string, name: string) {
  const user = userEvent.setup()
  renderWithQueryClient(<MemoryRouter><ImportWizard /></MemoryRouter>)
  await user.upload(fileInput(), csvFile(content, name))
  await screen.findByText(name)
  return user
}

/** The Map step's card of the column titled `header`. */
function columnCard(header: string): HTMLElement {
  const item = screen.getByRole('heading', { name: header }).closest('li')
  if (!(item instanceof HTMLElement)) throw new Error(`no card for ${header}`)
  return item
}

/** The parsed bodies of every `POST path` call, in order. */
function sentBodies(path: string): unknown[] {
  return fetchApi.mock.calls.filter(([endpoint, options]) => endpoint === path && options?.method === 'POST')
    .map(([, options]): unknown => (typeof options?.body === 'string' ? JSON.parse(options.body) : undefined))
}

const next = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Continue' }))

/** Through Map (Stars made a 1-10 rating) and Confirm, then Import; resolves once First insights shows. */
async function importReviews(user: ReturnType<typeof userEvent.setup>) {
  await next(user)
  await user.selectOptions(within(columnCard('Stars')).getByRole('combobox'), 'rating_1_10')
  await next(user)
  await screen.findByText('What goes where')
  await user.click(screen.getByRole('button', { name: 'Import' }))
  await screen.findByText('2 rows imported.')
}

const SURVEY_ROUTES = {
  'POST /scrapers/manual/detect': () => SURVEY_ANSWER,
  'POST /feedback-forms': () => ({ success: true, form: { form_id: 'ff_1' } }),
  'POST /feedback-forms/ff_1/import': () => ({ accepted: 1, refused: [{ row: 2, code: 'answer_invalid', question_id: 'q_plan' }],
                                               refused_count: 1, run_id: 'run-1', raw_s3_key: 's3://raw/raw/feedback_form/import/ff_1/x.csv' }),
}

describe('ImportWizard: reviews or tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insights.now = READY
    resetFetchApi()
    routeFetchApi({
      'POST /scrapers/manual/detect': () => REVIEWS_ANSWER,
      'POST /scrapers/manual/csv-upload': () => ({ success: true, imported_count: 2, total_rows: 2 }),
    })
  })

  it('takes a dropped file the way it takes a chosen one; Choose a file opens the picker, which is no Tab stop', async () => {
    renderWithQueryClient(<MemoryRouter><ImportWizard /></MemoryRouter>)
    const input = fileInput()
    expect(input).toHaveAttribute('tabindex', '-1')
    const opened = vi.spyOn(input, 'click').mockImplementation(() => {})
    await userEvent.setup().click(screen.getByRole('button', { name: 'Choose a file' }))
    expect(opened).toHaveBeenCalledTimes(1)
    const zone = screen.getByTestId('import-drop-zone')
    fireEvent.dragOver(zone)
    expect(zone).toHaveClass('border-accent')
    fireEvent.dragLeave(zone)
    expect(zone).not.toHaveClass('border-accent')
    const dropped = csvFile(REVIEWS, 'dropped.csv')
    fireEvent.drop(zone, { dataTransfer: { files: { length: 1, 0: dropped, item: () => dropped } } })
    expect(await screen.findByText('dropped.csv')).toBeInTheDocument()
    expect(sentFetchApiBody('/scrapers/manual/detect', 'POST')).toMatchObject({ format: 'csv', sample: REVIEWS })
  })

  it('previews the file and sends its first 256 KB to the detection', async () => {
    await upload(REVIEWS, 'reviews.csv')
    expect(screen.getByText(/2 rows, 4 columns/u)).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('Login fails')
    expect(sentFetchApiBody('/scrapers/manual/detect', 'POST')).toMatchObject({ format: 'csv', sample: REVIEWS, truncated: false })
  })

  it('suggests reviews, flags personal data and lets a person change a kind', async () => {
    const user = await upload(REVIEWS, 'reviews.csv')
    await next(user)
    expect(screen.getByRole('radio', { name: /Reviews or tickets/u })).toBeChecked()
    expect(within(columnCard('Email')).getByText(/Personal data/u)).toBeInTheDocument()
    expect(within(columnCard('Stars')).getByText('Likely')).toBeInTheDocument()
    await user.selectOptions(within(columnCard('Stars')).getByRole('combobox'), 'rating_1_10')
    expect(within(columnCard('Stars')).getByText('your choice')).toBeInTheDocument()
  })

  it('imports through the CSV import with the wizard mapping and a tag', async () => {
    await importReviews(await upload(REVIEWS, 'reviews.csv'))
    const sent = sentFetchApiBody('/scrapers/manual/csv-upload', 'POST')
    expect(sent).toMatchObject({ csv_text: REVIEWS, delimiter: ';', date_order: 'dmy',
      mapping: { Comment: 'open_text', Product: 'dimension:product', Stars: 'rating_1_10', Email: 'email' } })
    expect(JSON.stringify(sent)).toMatch(/"import_tag":"import-\d{4}-\d{2}-\d{2}-[a-z2-9]{4}"/u)
    expect(mockAfterIngest).toHaveBeenCalledWith({ afterIngest: true })
  })

  it('shows the first insights with a link to the dashboard', async () => {
    await importReviews(await upload(REVIEWS, 'reviews.csv'))
    expect(screen.getByRole('link', { name: 'Open the dashboard' })).toHaveAttribute('href', '/dashboard?source=manual_import')
    expect(screen.getByText('Fast delivery')).toBeInTheDocument()
    // L6 (7.71.02): the categories by the dashboard's labels (a configured name, else the id in words), never a key.
    expect(screen.getByRole('heading', { name: 'Top categories' }).nextElementSibling).toHaveTextContent(
      'Support desk (2)Delivery speed (1)')
  })

  it('says rows none of which was analysed in the window (a survey\'s, Q3) are still processing, without a spinner', async () => {
    insights.now = { ...READY, processed: 0, ready: false, stillProcessing: true }
    await importReviews(await upload(REVIEWS, 'reviews.csv'))
    expect(screen.getByRole('status')).toHaveTextContent("Still processing: see the form's Results later.")
    expect(document.querySelector('.animate-spin')).toBeNull()
  })

  it('says when the rows were imported before, with the link to the dashboard', async () => {
    insights.now = { ...READY, processed: 0, ready: false, alreadyImported: true }
    await importReviews(await upload(REVIEWS, 'reviews.csv'))
    expect(screen.getByRole('status')).toHaveTextContent('Nothing new to analyse: these rows were imported before.')
    expect(screen.getByRole('link', { name: 'See them on the dashboard' })).toHaveAttribute('href', '/dashboard?source=manual_import')
  })

  it('reads a file that is not UTF-8 as Windows-1252 and says so', async () => {
    const encode = (text: string) => [...new TextEncoder().encode(text)]
    const bytes = new Uint8Array([...encode('Comment;Product;Stars;Email\nOpini'), 0xf3, ...encode('n;App;5;\n')])
    const picked = new File([bytes], 'legacy.csv')
    Object.defineProperty(picked, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
    renderWithQueryClient(<MemoryRouter><ImportWizard /></MemoryRouter>)
    await userEvent.setup().upload(fileInput(), picked)
    expect(await screen.findByText(/read as Windows-1252/u)).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('Opinión')
  })

  it('needs an open-text column', async () => {
    const user = await upload(REVIEWS, 'reviews.csv')
    await next(user)
    await user.selectOptions(within(columnCard('Comment')).getByRole('combobox'), 'ignore')
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one open-text column')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })
})

describe('ImportWizard: a survey export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFetchApi()
    routeFetchApi(SURVEY_ROUTES)
  })

  async function toConfirm() {
    const user = await upload(SURVEY, 'Workshop results.csv')
    await next(user)
    await next(user)
    await screen.findByText('The questions it becomes')
    return user
  }

  it('confirms the questions inferred again from the whole file', async () => {
    await toConfirm()
    expect(screen.getByRole('textbox', { name: "The imported form's name" })).toHaveValue('Workshop results')
    expect(screen.getByText('2 options')).toBeInTheDocument()
    expect(sentBodies('/scrapers/manual/detect')[1]).toMatchObject({ target: 'survey', values: { Plan: ['Pro', 'Free'] },
      mapping: SURVEY_ANSWER.suggested.mapping })
  })

  it('creates an imported form, off, and imports its rows with the original file', async () => {
    const user = await toConfirm()
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('1 row imported.')
    expect(sentFetchApiBody('/feedback-forms', 'POST')).toMatchObject({ schema_version: 2, name: 'Workshop results',
      enabled: false, questions: DEFINITION.questions, imported: { from: 'file', filename: 'Workshop results.csv' } })
    expect(sentFetchApiBody('/feedback-forms/ff_1/import', 'POST')).toMatchObject({
      offset: 0, date_order: 'dmy', mapping: SURVEY_ANSWER.suggested.form.mapping,
      rows: [{ 'Response ID': 'r1', 'Recommend us?': '9', Plan: 'Pro' }, { 'Response ID': 'r2', 'Recommend us?': '6', Plan: 'Free' }],
      file: { name: 'Workshop results.csv', format: 'csv', content: SURVEY } })
  })

  it('resumes a failed import at the call that failed, into the same form', async () => {
    const lines = Array.from({ length: 300 }, (_unused, index) => `r${index},${index % 11},Pro`)
    const answered = { calls: 0 }
    routeFetchApi({ ...SURVEY_ROUTES, 'POST /feedback-forms/ff_1/import': (body) => {
      answered.calls += 1
      if (answered.calls === 2) throw new Error('API Error: 504')
      const rows = isRecord(body) && Array.isArray(body['rows']) ? body['rows'].length : 0
      return { accepted: rows, refused: [], refused_count: 0, run_id: `run-${answered.calls}`,
               raw_s3_key: 's3://raw/raw/feedback_form/import/ff_1/x.csv' }
    } })
    const user = await upload(`Response ID,Recommend us?,Plan\n${lines.join('\n')}\n`, 'Workshop results.csv')
    await next(user)
    await next(user)
    await screen.findByText('The questions it becomes')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The import stopped')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('300 rows imported.')
    expect(sentBodies('/feedback-forms')).toHaveLength(1)
    const calls = sentBodies('/feedback-forms/ff_1/import').filter(isRecord)
    expect(calls.map((call) => [call['offset'], Array.isArray(call['rows']) ? call['rows'].length : 0, 'file' in call,
                                call['file_key']])).toStrictEqual([
      [0, 250, true, undefined], [250, 50, false, 'raw/feedback_form/import/ff_1/x.csv'],
      [250, 50, false, 'raw/feedback_form/import/ff_1/x.csv']])
  })

  it('names the rows it did not import, links to the results and shows the NPS', async () => {
    const user = await toConfirm()
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Row 2: an answer is not one the question takes')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: "Open the form's results" })).toHaveAttribute('href', '/feedback-forms/ff_1/results')
    expect(screen.getByText('+20')).toBeInTheDocument()
  })
})

describe('ImportWizard: refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFetchApi()
    importRight.allowed = true
  })

  it('offers nothing but its reason to someone who may not import', () => {
    importRight.allowed = false
    renderWithQueryClient(<MemoryRouter><ImportWizard /></MemoryRouter>)
    expect(screen.getByText('Importing a file is for admins (in a workspace, its admins).')).toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('refuses another file type, in words', async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderWithQueryClient(<MemoryRouter><ImportWizard /></MemoryRouter>)
    await user.upload(fileInput(), new File(['x'], 'notes.pdf'))
    expect(await screen.findByRole('alert')).toHaveTextContent('This file type cannot be imported')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('says when the server could not read the file', async () => {
    routeFetchApi({})
    renderWithQueryClient(<MemoryRouter><ImportWizard /></MemoryRouter>)
    await userEvent.setup().upload(fileInput(), csvFile(REVIEWS, 'reviews.csv'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The file could not be read'))
  })
})
