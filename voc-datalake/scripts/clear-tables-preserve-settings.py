#!/usr/bin/env python3
"""Clear VoC DynamoDB tables for fresh start, preserving settings (categories, brand)."""
import boto3

dynamodb = boto3.resource('dynamodb')

# Clear feedback table completely
print("Clearing voc-feedback...")
feedback_table = dynamodb.Table('voc-feedback')
deleted = 0
scan_kwargs = {'ProjectionExpression': 'pk, sk'}
while True:
    response = feedback_table.scan(**scan_kwargs)
    items = response.get('Items', [])
    if items:
        with feedback_table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
                deleted += 1
    if 'LastEvaluatedKey' not in response:
        break
    scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
print(f"  Deleted {deleted} items from voc-feedback")

# Clear aggregates table but preserve SETTINGS# items
print("Clearing voc-aggregates (preserving SETTINGS#)...")
aggregates_table = dynamodb.Table('voc-aggregates')
deleted = 0
scan_kwargs = {'ProjectionExpression': 'pk, sk'}
while True:
    response = aggregates_table.scan(**scan_kwargs)
    items = response.get('Items', [])
    if items:
        with aggregates_table.batch_writer() as batch:
            for item in items:
                # Skip settings items
                if item['pk'].startswith('SETTINGS#'):
                    print(f"  Preserving: {item['pk']}")
                    continue
                batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
                deleted += 1
    if 'LastEvaluatedKey' not in response:
        break
    scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
print(f"  Deleted {deleted} items from voc-aggregates")

# Clear watermarks table completely
print("Clearing voc-watermarks...")
watermarks_table = dynamodb.Table('voc-watermarks')
deleted = 0
scan_kwargs = {'ProjectionExpression': '#s', 'ExpressionAttributeNames': {'#s': 'source'}}
while True:
    response = watermarks_table.scan(**scan_kwargs)
    items = response.get('Items', [])
    if items:
        with watermarks_table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={'source': item['source']})
                deleted += 1
    if 'LastEvaluatedKey' not in response:
        break
    scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
print(f"  Deleted {deleted} items from voc-watermarks")

print("Done!")
