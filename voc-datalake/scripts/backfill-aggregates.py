#!/usr/bin/env python3
"""
Backfill aggregates from existing feedback data in DynamoDB.
Run this script to populate the voc-aggregates table from voc-feedback data.

Usage:
    python scripts/backfill-aggregates.py
"""
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict

# Configuration
FEEDBACK_TABLE = 'voc-feedback'
AGGREGATES_TABLE = 'voc-aggregates'
REGION = 'us-west-2'

dynamodb = boto3.resource('dynamodb', region_name=REGION)
feedback_table = dynamodb.Table(FEEDBACK_TABLE)
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)


def scan_all_feedback():
    """Scan all items from feedback table."""
    items = []
    response = feedback_table.scan()
    items.extend(response.get('Items', []))
    
    while 'LastEvaluatedKey' in response:
        response = feedback_table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response.get('Items', []))
        print(f"Scanned {len(items)} items...")
    
    return items


def compute_aggregates(items):
    """Compute all aggregates from feedback items."""
    aggregates = defaultdict(lambda: defaultdict(lambda: {'count': 0, 'sum': Decimal('0')}))
    
    for item in items:
        date = item.get('date', datetime.now(timezone.utc).strftime('%Y-%m-%d'))
        source = item.get('source_platform', 'unknown')
        category = item.get('category', 'other')
        sentiment_label = item.get('sentiment_label', 'neutral')
        sentiment_score = item.get('sentiment_score', Decimal('0'))
        urgency = item.get('urgency', 'low')
        persona = item.get('persona_name', 'Unknown')
        
        # Convert sentiment_score to Decimal if it's a string
        if isinstance(sentiment_score, str):
            sentiment_score = Decimal(sentiment_score)
        
        # Daily totals
        aggregates['METRIC#daily_total'][date]['count'] += 1
        
        # Daily by source
        aggregates[f'METRIC#daily_source#{source}'][date]['count'] += 1
        
        # Daily by category
        aggregates[f'METRIC#daily_category#{category}'][date]['count'] += 1
        
        # Daily by sentiment
        aggregates[f'METRIC#daily_sentiment#{sentiment_label}'][date]['count'] += 1
        
        # Daily sentiment score average (store sum and count)
        if sentiment_score:
            aggregates['METRIC#daily_sentiment_avg'][date]['count'] += 1
            aggregates['METRIC#daily_sentiment_avg'][date]['sum'] += sentiment_score
        
        # Urgency counts
        if urgency == 'high':
            aggregates['METRIC#urgent'][date]['count'] += 1
        
        # Persona counts
        if persona:
            aggregates[f'METRIC#persona#{persona}'][date]['count'] += 1
    
    return aggregates


def write_aggregates(aggregates):
    """Write computed aggregates to DynamoDB."""
    ttl = int(datetime.now(timezone.utc).timestamp() + 90 * 24 * 60 * 60)  # 90 days
    now = datetime.now(timezone.utc).isoformat()
    
    count = 0
    for pk, dates in aggregates.items():
        for sk, values in dates.items():
            item = {
                'pk': pk,
                'sk': sk,
                'count': values['count'],
                'ttl': ttl,
                'updated_at': now
            }
            
            # Add sum for average calculations
            if values['sum'] != Decimal('0'):
                item['sum'] = values['sum']
            
            aggregates_table.put_item(Item=item)
            count += 1
            
            if count % 100 == 0:
                print(f"Written {count} aggregate records...")
    
    return count


def main():
    print("Starting aggregates backfill...")
    print(f"Reading from: {FEEDBACK_TABLE}")
    print(f"Writing to: {AGGREGATES_TABLE}")
    print()
    
    # Scan all feedback
    print("Scanning feedback table...")
    items = scan_all_feedback()
    print(f"Found {len(items)} feedback items")
    print()
    
    # Compute aggregates
    print("Computing aggregates...")
    aggregates = compute_aggregates(items)
    print(f"Computed {len(aggregates)} aggregate metrics")
    print()
    
    # Write to DynamoDB
    print("Writing aggregates to DynamoDB...")
    count = write_aggregates(aggregates)
    print(f"Written {count} aggregate records")
    print()
    
    print("Backfill complete!")


if __name__ == '__main__':
    main()
