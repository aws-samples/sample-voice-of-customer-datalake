#!/usr/bin/env python3
"""Clear all VoC DynamoDB tables for fresh start."""
import boto3

dynamodb = boto3.resource('dynamodb')

tables_config = [
    ('voc-feedback', ['pk', 'sk']),
    ('voc-aggregates', ['pk', 'sk']),
    ('voc-watermarks', ['source']),
]

for table_name, key_names in tables_config:
    table = dynamodb.Table(table_name)
    print(f"Clearing {table_name}...")
    
    # Handle reserved keywords
    proj_expr = ', '.join([f'#{k}' for k in key_names])
    expr_names = {f'#{k}': k for k in key_names}
    
    deleted = 0
    scan_kwargs = {
        'ProjectionExpression': proj_expr,
        'ExpressionAttributeNames': expr_names
    }
    
    while True:
        response = table.scan(**scan_kwargs)
        items = response.get('Items', [])
        
        if items:
            with table.batch_writer() as batch:
                for item in items:
                    batch.delete_item(Key={k: item[k] for k in key_names})
                    deleted += 1
        
        if 'LastEvaluatedKey' not in response:
            break
        scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
    
    print(f"  Deleted {deleted} items from {table_name}")

print("Done!")
