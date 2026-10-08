"""SQS event records for driving `processor.handler.lambda_handler` through its BatchProcessor."""
import json


def sqs_record(message_id: str, body: dict) -> dict:
    """One SQS record carrying `body` as its JSON message body."""
    return {
        'messageId': message_id, 'receiptHandle': 'rh', 'body': json.dumps(body), 'attributes': {},
        'messageAttributes': {}, 'md5OfBody': '', 'eventSource': 'aws:sqs',
        'eventSourceARN': 'arn:aws:sqs:us-east-1:123456789012:q', 'awsRegion': 'us-east-1',
    }
