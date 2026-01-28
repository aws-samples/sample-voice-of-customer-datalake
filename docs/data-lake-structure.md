# Data Lake Structure

This document describes the VoC data lake architecture, including S3 storage structure, DynamoDB tables, and the Data Explorer feature.

## Overview

The VoC platform stores data in two primary locations:

1. **S3 Raw Data Bucket** - Immutable raw data from all sources
2. **DynamoDB Tables** - Processed, queryable feedback data

## S3 Raw Data Structure

Raw data is stored in S3 with a partitioned folder structure:

```
s3://voc-raw-data-bucket/
└── raw/
    └── {source_platform}/
        └── {year}/
            └── {month}/
                └── {day}/
                    └── {item_id}.json
```

### Example Paths

```
raw/webscraper/2026/01/08/abc123def456.json
raw/feedback_form/2026/01/08/uuid-here.json
```

### Raw Data File Format

Each JSON file contains:

```json
{
  "item_id": "abc123def456",
  "source_platform": "webscraper",
  "ingested_at": "2026-01-08T10:30:00Z",
  "partition_date": "2026-01-08",
  "raw_content": "Original API response (optional)",
  "raw_item": {
    "id": "original_source_id",
    "text": "The feedback content",
    "rating": 4.5,
    "created_at": "2026-01-07T15:00:00Z",
    "url": "https://source.com/review/123",
    "author": "John D."
  }
}
```

### Partitioning Strategy

Data is partitioned by:

1. **Source platform** - Isolates data by origin
2. **Date** - Year/month/day hierarchy for efficient queries
3. **Item ID** - Deterministic filename prevents duplicates

## DynamoDB Tables

### Feedback Table

Primary table for processed feedback:

| Key | Type | Description |
|-----|------|-------------|
| `pk` | Partition | `SOURCE#{source_platform}` |
| `sk` | Sort | `FEEDBACK#{feedback_id}` |

#### Global Secondary Indexes

| GSI | Partition Key | Sort Key | Use Case |
|-----|---------------|----------|----------|
| GSI1 | `DATE#{date}` | `{timestamp}#{id}` | Query by date |
| GSI2 | `CATEGORY#{category}` | `{score}#{timestamp}` | Query by category |
| GSI3 | `URGENCY#{urgency}` | `{timestamp}` | Query urgent items |

### Aggregates Table

Stores aggregated data, settings, and logs:

| Key Pattern | Description |
|-------------|-------------|
| `SETTINGS#*` | Configuration data |
| `LOGS#*` | Processing logs |
| `SCRAPER_RUN#*` | Scraper execution history |
| `FEEDBACK_FORM` | Form configurations |

### Watermarks Table

Tracks ingestion progress per source:

| Key | Value |
|-----|-------|
| `{source}#{key}` | Last processed ID or timestamp |

## Data Explorer

The Data Explorer provides a UI for browsing and managing data lake contents.

### Features

- **S3 Browser**: Navigate folders, preview files, edit JSON
- **Feedback Editor**: View and modify processed feedback
- **Sync**: Push changes between S3 and DynamoDB

### Available Buckets

| Bucket | Description |
|--------|-------------|
| `raw-data` | VoC raw feedback data |

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/data-explorer/buckets` | List available buckets |
| GET | `/data-explorer/s3` | List S3 objects |
| GET | `/data-explorer/s3/preview` | Preview file content |
| PUT | `/data-explorer/s3` | Create/update file |
| DELETE | `/data-explorer/s3` | Delete file |
| PUT | `/data-explorer/feedback` | Update feedback record |
| DELETE | `/data-explorer/feedback` | Delete feedback record |
| GET | `/data-explorer/stats` | Get data lake statistics |

### Syncing Data

When editing data, you can sync changes:

- **S3 → DynamoDB**: Edit raw data and reprocess through the pipeline
- **DynamoDB → S3**: Update processed data and sync back to raw storage

## Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Plugin    │────▶│  S3 Raw     │     │  DynamoDB   │
│  Ingestor   │     │  Storage    │     │  Feedback   │
└─────────────┘     └─────────────┘     └─────────────┘
                           │                   ▲
                           ▼                   │
                    ┌─────────────┐     ┌─────────────┐
                    │    SQS      │────▶│  Processor  │
                    │   Queue     │     │   Lambda    │
                    └─────────────┘     └─────────────┘
```

1. **Ingestor** fetches data from source
2. **Raw data** stored in S3 (immutable archive)
3. **Message** sent to SQS queue
4. **Processor** enriches with LLM analysis
5. **Processed data** stored in DynamoDB

## Retention

- **S3 Raw Data**: Retained indefinitely (configure lifecycle rules as needed)
- **DynamoDB Feedback**: 1 year TTL (configurable)
- **Processing Logs**: 7 days TTL

## Querying Data

### By Date Range

```python
response = table.query(
    IndexName='gsi1',
    KeyConditionExpression='gsi1pk = :pk',
    ExpressionAttributeValues={':pk': f'DATE#2026-01-08'}
)
```

### By Category

```python
response = table.query(
    IndexName='gsi2',
    KeyConditionExpression='gsi2pk = :pk',
    ExpressionAttributeValues={':pk': 'CATEGORY#product_quality'}
)
```

### By Source

```python
response = table.query(
    KeyConditionExpression='pk = :pk',
    ExpressionAttributeValues={':pk': 'SOURCE#webscraper'}
)
```

## Best Practices

1. **Use GSIs for queries**: Avoid table scans
2. **Leverage partitioning**: Query specific date ranges
3. **Keep raw data immutable**: Edit processed data, not raw
4. **Monitor storage costs**: Set up S3 lifecycle policies
5. **Use Data Explorer for debugging**: Preview and edit data easily
