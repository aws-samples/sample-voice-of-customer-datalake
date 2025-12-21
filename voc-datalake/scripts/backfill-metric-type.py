#!/usr/bin/env python3
"""
Backfill script to add metric_type attribute to existing aggregates records.
This enables the gsi1-by-metric-type GSI for efficient queries.
"""
import boto3

dynamodb = boto3.resource('dynamodb')
aggregates_table = dynamodb.Table('voc-aggregates')


def get_metric_type(pk: str) -> str | None:
    """Extract metric type from pk for GSI indexing."""
    if pk.startswith('METRIC#daily_source#'):
        return 'source'
    elif pk.startswith('METRIC#persona#'):
        return 'persona'
    return None


def backfill():
    """Scan aggregates table and add metric_type where applicable."""
    updated = 0
    scanned = 0
    last_key = None
    
    while True:
        scan_params = {}
        if last_key:
            scan_params['ExclusiveStartKey'] = last_key
        
        response = aggregates_table.scan(**scan_params)
        items = response.get('Items', [])
        scanned += len(items)
        
        for item in items:
            pk = item.get('pk', '')
            metric_type = get_metric_type(pk)
            
            # Only update if metric_type is applicable and not already set
            if metric_type and item.get('metric_type') != metric_type:
                aggregates_table.update_item(
                    Key={'pk': pk, 'sk': item['sk']},
                    UpdateExpression='SET metric_type = :mt',
                    ExpressionAttributeValues={':mt': metric_type}
                )
                updated += 1
                print(f"Updated: {pk} -> metric_type={metric_type}")
        
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
        
        print(f"Progress: scanned {scanned} items, updated {updated}...")
    
    print(f"\nDone! Scanned {scanned} items, updated {updated} with metric_type.")


if __name__ == '__main__':
    backfill()
