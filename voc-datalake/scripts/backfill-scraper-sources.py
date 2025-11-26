#!/usr/bin/env python3
"""
Backfill script to update webscraper feedback records with proper source names.

This script:
1. Scans for all feedback items with source_platform = 'webscraper'
2. Extracts the scraper_name from raw_data
3. Updates source_platform to use the scraper name
4. Updates the aggregates table to reflect the new source names

Usage:
    python3 scripts/backfill-scraper-sources.py [--dry-run]
"""
import boto3
import json
import sys
from datetime import datetime, timezone
from collections import defaultdict

# Configuration
FEEDBACK_TABLE = 'voc-feedback'
AGGREGATES_TABLE = 'voc-aggregates'
REGION = 'us-west-2'

# Initialize clients
dynamodb = boto3.resource('dynamodb', region_name=REGION)
feedback_table = dynamodb.Table(FEEDBACK_TABLE)
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)


def get_webscraper_items():
    """Scan for all items with source_platform = webscraper."""
    items = []
    last_key = None
    
    print("Scanning for webscraper items...")
    
    while True:
        scan_params = {
            'FilterExpression': 'source_platform = :sp',
            'ExpressionAttributeValues': {':sp': 'webscraper'}
        }
        if last_key:
            scan_params['ExclusiveStartKey'] = last_key
        
        response = feedback_table.scan(**scan_params)
        items.extend(response.get('Items', []))
        
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
        
        print(f"  Found {len(items)} items so far...")
    
    return items


def extract_scraper_name(item):
    """Extract scraper name from raw_data or URL."""
    # First try raw_data
    raw_data = item.get('raw_data', {})
    
    # Handle case where raw_data is a string (JSON)
    if isinstance(raw_data, str):
        try:
            raw_data = json.loads(raw_data)
        except json.JSONDecodeError:
            raw_data = {}
    
    if raw_data:
        # Try different fields that might contain the scraper name
        scraper_name = (
            raw_data.get('scraper_name') or
            raw_data.get('source_platform_override') or
            raw_data.get('domain')
        )
        if scraper_name:
            return scraper_name
    
    # Fallback: extract domain from source_url
    source_url = item.get('source_url', '')
    if source_url:
        from urllib.parse import urlparse
        parsed = urlparse(source_url)
        domain = parsed.netloc
        
        # Map common domains to friendly names
        domain_map = {
            'www.trustpilot.com': 'Trustpilot',
            'trustpilot.com': 'Trustpilot',
            'www.consumeraffairs.com': 'ConsumerAffairs',
            'consumeraffairs.com': 'ConsumerAffairs',
            'www.yelp.com': 'Yelp',
            'yelp.com': 'Yelp',
            'www.google.com': 'Google Reviews',
            'play.google.com': 'Google Play',
            'apps.apple.com': 'App Store',
        }
        
        return domain_map.get(domain, domain)
    
    return None


def update_feedback_item(item, new_source_platform, dry_run=False):
    """Update a feedback item with the new source_platform."""
    pk = item['pk']
    sk = item['sk']
    
    if dry_run:
        print(f"  [DRY RUN] Would update {pk}/{sk} -> {new_source_platform}")
        return True
    
    try:
        feedback_table.update_item(
            Key={'pk': pk, 'sk': sk},
            UpdateExpression='SET source_platform = :sp',
            ExpressionAttributeValues={':sp': new_source_platform}
        )
        return True
    except Exception as e:
        print(f"  Error updating {pk}/{sk}: {e}")
        return False


def update_aggregates(source_counts, date_source_counts, dry_run=False):
    """Update aggregates table with new source counts."""
    print("\nUpdating aggregates...")
    
    # First, we need to decrement webscraper counts and increment new source counts
    for date, sources in date_source_counts.items():
        webscraper_count = sources.get('webscraper', 0)
        
        if webscraper_count > 0 and not dry_run:
            # Decrement webscraper count
            try:
                aggregates_table.update_item(
                    Key={'pk': 'METRIC#daily_source#webscraper', 'sk': date},
                    UpdateExpression='SET #count = #count - :dec',
                    ExpressionAttributeNames={'#count': 'count'},
                    ExpressionAttributeValues={':dec': webscraper_count}
                )
            except Exception as e:
                print(f"  Error decrementing webscraper for {date}: {e}")
        
        # Increment new source counts
        for source, count in sources.items():
            if source == 'webscraper':
                continue
            
            if dry_run:
                print(f"  [DRY RUN] Would add {count} to METRIC#daily_source#{source} for {date}")
            else:
                try:
                    aggregates_table.update_item(
                        Key={'pk': f'METRIC#daily_source#{source}', 'sk': date},
                        UpdateExpression='SET #count = if_not_exists(#count, :zero) + :inc',
                        ExpressionAttributeNames={'#count': 'count'},
                        ExpressionAttributeValues={':inc': count, ':zero': 0}
                    )
                except Exception as e:
                    print(f"  Error updating {source} for {date}: {e}")


def main():
    dry_run = '--dry-run' in sys.argv
    
    if dry_run:
        print("=" * 60)
        print("DRY RUN MODE - No changes will be made")
        print("=" * 60)
    
    print("\n" + "=" * 60)
    print("BACKFILL WEBSCRAPER SOURCE NAMES")
    print("=" * 60)
    
    # Get all webscraper items
    items = get_webscraper_items()
    print(f"\nFound {len(items)} items with source_platform = 'webscraper'")
    
    if not items:
        print("Nothing to update!")
        return
    
    # Group by scraper name and date for aggregates
    source_counts = defaultdict(int)
    date_source_counts = defaultdict(lambda: defaultdict(int))
    items_to_update = []
    
    for item in items:
        scraper_name = extract_scraper_name(item)
        
        if scraper_name and scraper_name != 'webscraper':
            items_to_update.append((item, scraper_name))
            source_counts[scraper_name] += 1
            
            # Get date for aggregates
            created_at = item.get('source_created_at', item.get('processed_at', ''))
            if created_at:
                date = created_at[:10]  # YYYY-MM-DD
                date_source_counts[date][scraper_name] += 1
                date_source_counts[date]['webscraper'] += 1  # Track what to decrement
    
    print(f"\nItems to update: {len(items_to_update)}")
    print("\nSource breakdown:")
    for source, count in sorted(source_counts.items(), key=lambda x: -x[1]):
        print(f"  {source}: {count}")
    
    if not items_to_update:
        print("\nNo items have scraper_name in raw_data. Nothing to update.")
        return
    
    # Confirm before proceeding
    if not dry_run:
        print(f"\nThis will update {len(items_to_update)} feedback items.")
        confirm = input("Proceed? (yes/no): ")
        if confirm.lower() != 'yes':
            print("Aborted.")
            return
    
    # Update feedback items
    print("\nUpdating feedback items...")
    success_count = 0
    error_count = 0
    
    for i, (item, new_source) in enumerate(items_to_update):
        if update_feedback_item(item, new_source, dry_run):
            success_count += 1
        else:
            error_count += 1
        
        if (i + 1) % 100 == 0:
            print(f"  Processed {i + 1}/{len(items_to_update)}...")
    
    print(f"\nFeedback items: {success_count} updated, {error_count} errors")
    
    # Update aggregates
    update_aggregates(source_counts, date_source_counts, dry_run)
    
    print("\n" + "=" * 60)
    print("BACKFILL COMPLETE")
    print("=" * 60)
    
    if dry_run:
        print("\nRun without --dry-run to apply changes.")


if __name__ == '__main__':
    main()
