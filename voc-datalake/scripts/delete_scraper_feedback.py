#!/usr/bin/env python3
"""
Delete feedback items from a specific scraper source.
Usage: python3 scripts/delete_scraper_feedback.py "Lufthansa - Trustpilot"
"""
import boto3
import sys

def delete_feedback_by_source(source_name: str, dry_run: bool = False):
    dynamodb = boto3.resource('dynamodb')
    feedback_table = dynamodb.Table('voc-feedback')
    
    print(f"Scanning for items with source: {source_name}")
    
    # Scan for items with this source
    items_to_delete = []
    response = feedback_table.scan(
        FilterExpression='begins_with(pk, :src)',
        ExpressionAttributeValues={':src': f'SOURCE#{source_name}'},
        ProjectionExpression='pk, sk'
    )
    items_to_delete.extend(response.get('Items', []))
    
    # Handle pagination
    while 'LastEvaluatedKey' in response:
        response = feedback_table.scan(
            FilterExpression='begins_with(pk, :src)',
            ExpressionAttributeValues={':src': f'SOURCE#{source_name}'},
            ProjectionExpression='pk, sk',
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        items_to_delete.extend(response.get('Items', []))
    
    print(f"Found {len(items_to_delete)} items to delete")
    
    if dry_run:
        print("DRY RUN - no items deleted")
        return
    
    if len(items_to_delete) == 0:
        print("No items to delete")
        return
    
    # Confirm
    confirm = input(f"Delete {len(items_to_delete)} items? (yes/no): ")
    if confirm.lower() != 'yes':
        print("Aborted")
        return
    
    # Delete in batches
    deleted = 0
    with feedback_table.batch_writer() as batch:
        for item in items_to_delete:
            batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
            deleted += 1
            if deleted % 25 == 0:
                print(f"Deleted {deleted}/{len(items_to_delete)}...")
    
    print(f"Deleted {deleted} items from voc-feedback table")
    
    # Also clear watermark so scraper runs fresh
    watermarks_table = dynamodb.Table('voc-watermarks')
    # Find scraper watermarks
    response = watermarks_table.scan()
    for item in response.get('Items', []):
        if source_name.lower().replace(' ', '_').replace('-', '_') in item.get('source', '').lower():
            print(f"Deleting watermark: {item['source']}")
            watermarks_table.delete_item(Key={'source': item['source']})

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/delete_scraper_feedback.py 'Source Name'")
        print("Example: python3 scripts/delete_scraper_feedback.py 'Lufthansa - Trustpilot'")
        sys.exit(1)
    
    source = sys.argv[1]
    dry_run = '--dry-run' in sys.argv
    delete_feedback_by_source(source, dry_run)
