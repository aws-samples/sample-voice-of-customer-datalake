# Manual Import Feature

> Design document for manual review import functionality when automated scrapers are blocked.

## Problem Statement

Automated web scrapers can be blocked by CAPTCHAs, rate limits, or anti-bot measures. Users need a fallback to manually copy-paste reviews from websites and have them processed through the existing pipeline.

## Solution Overview

Add a "Manual Import" button to the Scrapers page that allows users to:
1. Paste a URL (source identification)
2. Paste raw review text (up to 10,000 characters)
3. LLM parses the text into individual reviews
4. User previews and edits parsed reviews
5. Confirm to send to processing pipeline

## Implementation Status

✅ **Completed:**
- Backend: `manual_import_handler.py` - API endpoints for parse, status, confirm
- Backend: `manual_import_processor.py` - Async LLM parsing with extended thinking
- Frontend: `manualImportStore.ts` - Zustand store with persistence
- Frontend: `ManualImportModal.tsx` - Full modal with input, processing, preview steps
- Frontend: `ParsedReviewCard.tsx` - Editable review card component
- Frontend: API client methods added to `client.ts`
- Frontend: Scrapers page updated with Manual Import button
- CDK: `analytics-stack.ts` - Lambda definitions and API Gateway routes

## Architecture

### Flow Diagram

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ 1. Click    │────▶│ 2. Modal:   │────▶│ 3. Submit   │────▶│ 4. Poll     │────▶│ 5. Preview  │
│ "Manual     │     │ Enter URL + │     │ Parse job   │     │ for result  │     │ & Edit      │
│ Import"     │     │ paste text  │     │ (async)     │     │ (2s)        │     │ cards       │
│             │     │             │     │             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └──────┬──────┘
                                                                                       │
                                                                                       ▼
                                                                                ┌─────────────┐
                                                                                │ 6. Confirm  │
                                                                                │ → S3 + SQS  │
                                                                                └─────────────┘
```

### Why Async?

API Gateway has a 29-second hard limit. Bedrock with extended thinking on 10k characters can take 30-60+ seconds. Solution:

1. `POST /scrapers/manual/parse` returns `{ job_id }` immediately
2. Lambda processes asynchronously (5 min timeout)
3. Frontend polls `GET /scrapers/manual/parse/{job_id}` every 2 seconds
4. Job stored in DynamoDB with 1-hour TTL

## Source Identification

### URL-Based Detection

Instead of a dropdown, user provides the URL they copied from. Domain is extracted and mapped to a known source:

```typescript
const DOMAIN_TO_SOURCE: Record<string, string> = {
  'trustpilot.com': 'trustpilot',
  'www.trustpilot.com': 'trustpilot',
  'g2.com': 'g2',
  'capterra.com': 'capterra',
  'google.com': 'google_reviews',
  'yelp.com': 'yelp',
  'apps.apple.com': 'app_store',
  'play.google.com': 'play_store',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'facebook.com': 'facebook',
  'reddit.com': 'reddit',
  'linkedin.com': 'linkedin',
  'instagram.com': 'instagram',
  'tiktok.com': 'tiktok',
  'youtube.com': 'youtube',
}
```

### Unknown Domains

If domain not in map, use sanitized domain as source:
- `www.reviews.io` → `reviews.io`
- `uk.trustpilot.com` → `trustpilot` (if mapped)

### Benefits

- No typo fragmentation ("Trustpilot" vs "trustpilot" vs "Trust Pilot")
- Full URL stored for debugging/reference
- Auto-handles new review sites
- Less user effort (just paste URL they already have open)

## LLM Parsing Strategy

### Model

```
global.anthropic.claude-sonnet-4-5-20250929-v1:0
```

### Parameters

| Parameter | Value | Reason |
|-----------|-------|--------|
| `temperature` | 0 | Deterministic output for deduplication hash consistency |
| `thinking.budget_tokens` | 5000 | Enough for complex parsing |
| `max_tokens` | 4096 | Output limit |

### Prompt Rules

- **Extract ONLY** - do not paraphrase, rewrite, or summarize
- **Preserve exact original text** for each review
- Return `unparsed_sections` for text that couldn't be parsed
- Output strict JSON schema

### Output Schema

```json
{
  "reviews": [
    {
      "text": "exact original review text...",
      "rating": 5,
      "author": "John D.",
      "date": "2026-01-05",
      "title": "Great product"
    }
  ],
  "unparsed_sections": ["...any text that couldn't be parsed..."]
}
```

## API Endpoints

### POST /scrapers/manual/parse

Start async parse job.

**Request:**
```json
{
  "source_url": "https://trustpilot.com/review/acme.com",
  "raw_text": "...pasted reviews..."
}
```

**Response:**
```json
{
  "job_id": "uuid-xxx"
}
```

### GET /scrapers/manual/parse/{job_id}

Poll for job status.

**Response (processing):**
```json
{
  "status": "processing"
}
```

**Response (completed):**
```json
{
  "status": "completed",
  "source_origin": "trustpilot",
  "reviews": [
    {
      "text": "Great product!",
      "rating": 5,
      "author": "John D.",
      "date": "2026-01-05",
      "title": "Amazing"
    }
  ],
  "unparsed_sections": []
}
```

**Response (failed):**
```json
{
  "status": "failed",
  "error": "Error message"
}
```

### POST /scrapers/manual/confirm

Confirm import after user edits.

**Request:**
```json
{
  "job_id": "uuid-xxx",
  "reviews": [
    {
      "text": "Great product!",
      "rating": 5,
      "author": "John D.",
      "date": "2026-01-05",
      "title": "Amazing"
    }
  ]
}
```

**Response:**
```json
{
  "imported_count": 5,
  "s3_uri": "s3://voc-raw-data/.../manual-import-uuid.json"
}
```

## Data Models

### Job (DynamoDB - voc-aggregates table)

```json
{
  "pk": "MANUAL_IMPORT#uuid-xxx",
  "sk": "JOB",
  "status": "processing | completed | failed",
  "source_url": "https://trustpilot.com/review/acme.com",
  "source_origin": "trustpilot",
  "raw_text": "...original pasted text...",
  "reviews": [],
  "unparsed_sections": [],
  "error": null,
  "created_at": "2026-01-07T20:00:00Z",
  "ttl": 1736283600
}
```

### Feedback Item (sent to SQS)

```json
{
  "id": "manual-uuid-xxx-0",
  "source_platform": "manual_import",
  "source_origin": "trustpilot",
  "source_url": "https://trustpilot.com/review/acme.com",
  "ingestion_method": "manual",
  "manual_import_job_id": "uuid-xxx",
  "text": "Great product!",
  "rating": 5,
  "author": "John D.",
  "source_created_at": "2026-01-05",
  "title": "Amazing"
}
```

### S3 Storage

**Path:** `raw/manual_import/{year}/{month}/{day}/{job_id}.json`

**Contents:**
```json
{
  "job_id": "uuid-xxx",
  "source_url": "https://trustpilot.com/review/acme.com",
  "source_origin": "trustpilot",
  "raw_text": "...original pasted text...",
  "llm_response": { "reviews": [...], "unparsed_sections": [...] },
  "final_reviews": [...edited reviews...],
  "imported_at": "2026-01-07T20:05:00Z",
  "imported_by": "user-id"
}
```

## Frontend Components

### Files to Create

| File | Purpose |
|------|---------|
| `frontend/src/store/manualImportStore.ts` | Zustand store with persist for draft state |
| `frontend/src/pages/Scrapers/ManualImportModal.tsx` | Main modal with URL + paste + preview flow |
| `frontend/src/pages/Scrapers/ParsedReviewCard.tsx` | Editable review card component |

### Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/pages/Scrapers/Scrapers.tsx` | Add "Manual Import" button |
| `frontend/src/api/client.ts` | Add API methods for manual import |

### Zustand Store (manualImportStore.ts)

```typescript
interface ManualImportState {
  // Draft persistence
  sourceUrl: string
  rawText: string
  parsedReviews: ParsedReview[]
  jobId: string | null
  lastUpdated: string | null
  
  // Actions
  setSourceUrl: (url: string) => void
  setRawText: (text: string) => void
  setParsedReviews: (reviews: ParsedReview[]) => void
  setJobId: (id: string | null) => void
  clearDraft: () => void
}
```

Persisted to localStorage - survives page refresh.

### UI Mockup - Input Modal

```
┌─────────────────────────────────────────────────────────────┐
│                     Manual Import                     [X]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Source URL *                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ https://trustpilot.com/review/acme.com              │   │
│  └─────────────────────────────────────────────────────┘   │
│  ✓ Detected: Trustpilot                                    │
│                                                             │
│  Paste reviews *                               2,450/10,000 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ John D. - 5 stars                                   │   │
│  │ Great product! Really helped our team...            │   │
│  │                                                     │   │
│  │ Sarah M. - 4 stars                                  │   │
│  │ Good but could be better...                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│                              [Cancel]  [Parse Reviews →]    │
└─────────────────────────────────────────────────────────────┘
```

### UI Mockup - Processing State

```
┌─────────────────────────────────────────────────────────────┐
│                     Manual Import                     [X]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    ┌──────────────┐                         │
│                    │   ◠ ◠ ◠      │                         │
│                    └──────────────┘                         │
│                                                             │
│              Parsing reviews with AI...                     │
│         This may take 30-60 seconds for large pastes        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### UI Mockup - Preview & Edit

```
┌─────────────────────────────────────────────────────────────┐
│                  Review Preview (5 found)             [X]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ★★★★★  John D. · Jan 5, 2026                    [🗑️] │ │
│  │ ┌───────────────────────────────────────────────────┐ │ │
│  │ │ Great product! Really helped our team improve...  │ │ │
│  │ └───────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ★★★★☆  Sarah M. · Jan 3, 2026                   [🗑️] │ │
│  │ ┌───────────────────────────────────────────────────┐ │ │
│  │ │ Good but could be better. The UI is confusing...  │ │ │
│  │ └───────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  [+ Add Review Manually]                                    │
│                                                             │
│  ⚠️ 1 section could not be parsed (view)                   │
│                                                             │
│                    [← Back]  [Import 5 Reviews]             │
└─────────────────────────────────────────────────────────────┘
```

### Zero Reviews Parsed

```
┌─────────────────────────────────────────────────────────────┐
│                     Manual Import                     [X]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                        ⚠️                                   │
│              No reviews could be detected                   │
│                                                             │
│  The pasted text didn't contain recognizable reviews.       │
│  You can add reviews manually below.                        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ Unparsed text:                                        │ │
│  │ "Navigation menu Home About Contact..."               │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  [+ Add Review Manually]                                    │
│                                                             │
│                       [← Back]  [Continue →]                │
└─────────────────────────────────────────────────────────────┘
```

## Backend Implementation

### Files to Create

| File | Purpose |
|------|---------|
| `lambda/api/manual_import_handler.py` | New Lambda for manual import endpoints |
| `lambda/api/prompts/manual_parse_prompt.py` | LLM prompt for parsing |

### Files to Modify

| File | Changes |
|------|---------|
| `lib/stacks/analytics-stack.ts` | Add new Lambda + API routes |

### Lambda Handler Structure

```python
# manual_import_handler.py

@app.post("/scrapers/manual/parse")
def start_parse():
    # 1. Validate URL and text
    # 2. Extract source_origin from URL domain
    # 3. Create job in DynamoDB (status: processing)
    # 4. Invoke async processing (Lambda async invoke or Step Function)
    # 5. Return job_id

@app.get("/scrapers/manual/parse/<job_id>")
def get_parse_status():
    # 1. Get job from DynamoDB
    # 2. Return status + reviews if completed

@app.post("/scrapers/manual/confirm")
def confirm_import():
    # 1. Get job from DynamoDB
    # 2. Store to S3 (raw + llm response + final edits)
    # 3. Send each review to SQS
    # 4. Return success + s3_uri
```

### Async Processing Options

**Option A: Lambda Async Invoke**
- Main Lambda invokes processing Lambda with `InvocationType='Event'`
- Processing Lambda calls Bedrock, updates DynamoDB
- Simple, no new infrastructure

**Option B: Step Functions**
- More visible, better error handling
- Overkill for single-step process

**Recommendation:** Option A (Lambda async invoke)

## Configuration

| Setting | Value |
|---------|-------|
| Max characters | 10,000 |
| Thinking budget | 5,000 tokens |
| Temperature | 0 |
| Job TTL | 1 hour |
| Poll interval | 2 seconds |
| Lambda timeout | 5 minutes |

## Error Handling

| Error | Handling |
|-------|----------|
| Invalid URL | Frontend validation, show error |
| Text too long | Frontend prevents paste > 10k |
| LLM parsing fails | Return `status: failed` with error message |
| Partial parse | Return parsed reviews + unparsed_sections |
| Zero reviews | Show unparsed text, allow manual entry |
| SQS send fails | Return which reviews failed, allow retry |
| Job expired | Re-parse (draft still in Zustand) |

## Security

- **Auth required**: Only authenticated users can use manual import
- **Prompt injection**: Strict JSON output schema, validate LLM response
- **Rate limiting**: Not needed (auth users, Bedrock costs are acceptable)

## Testing Checklist

- [ ] URL parsing extracts correct domain
- [ ] Known domains map to correct source
- [ ] Unknown domains use sanitized domain
- [ ] Character counter works correctly
- [ ] Polling stops on completed/failed
- [ ] Draft persists across page refresh
- [ ] Draft clears on successful import
- [ ] Edit review text works
- [ ] Delete review works
- [ ] Add manual review works
- [ ] Zero reviews shows manual entry option
- [ ] Unparsed sections displayed
- [ ] S3 storage contains all data
- [ ] SQS messages have correct format
- [ ] Feedback appears in dashboard after processing

## Future Enhancements

1. **Bulk URL import** - Paste multiple URLs, fetch and parse each
2. **Browser extension** - One-click import from review page
3. **Template hints** - Tell LLM "this is Trustpilot format" for better parsing
4. **Import history** - Show past manual imports with counts
