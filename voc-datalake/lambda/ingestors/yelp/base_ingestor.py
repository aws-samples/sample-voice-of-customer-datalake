"""
Base Ingestor - Common functionality for all VoC data source ingestors.
Uses DynamoDB for watermarks and SQS for processing queue.
"""
import json
import os
import boto3
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Generator
from aws_lambda_powertools import Logger, Tracer, Metrics

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="VoC-Ingestion")

# AWS Clients
dynamodb = boto3.resource('dynamodb')
sqs = boto3.client('sqs')
secrets_client = boto3.client('secretsmanager')

# Configuration
WATERMARKS_TABLE = os.environ['WATERMARKS_TABLE']
PROCESSING_QUEUE_URL = os.environ['PROCESSING_QUEUE_URL']
SECRETS_ARN = os.environ['SECRETS_ARN']
BRAND_NAME = os.environ['BRAND_NAME']
BRAND_HANDLES = json.loads(os.environ.get('BRAND_HANDLES', '[]'))
SOURCE_PLATFORM = os.environ['SOURCE_PLATFORM']


class BaseIngestor(ABC):
    """Base class for all data source ingestors."""
    
    def __init__(self):
        self.secrets = self._load_secrets()
        self.watermarks_table = dynamodb.Table(WATERMARKS_TABLE)
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        self.brand_handles = BRAND_HANDLES
    
    def _load_secrets(self) -> dict:
        """Load API credentials from Secrets Manager."""
        try:
            response = secrets_client.get_secret_value(SecretId=SECRETS_ARN)
            return json.loads(response['SecretString'])
        except Exception as e:
            logger.error(f"Failed to load secrets: {e}")
            return {}
    
    def get_watermark(self, key: str, default: str = None) -> str:
        """Get watermark for a specific source/key from DynamoDB."""
        try:
            response = self.watermarks_table.get_item(
                Key={'source': f"{self.source_platform}#{key}"}
            )
            return response.get('Item', {}).get('value', default)
        except Exception as e:
            logger.warning(f"Failed to get watermark: {e}")
            return default
    
    def set_watermark(self, key: str, value: str):
        """Set watermark for a specific source/key in DynamoDB."""
        try:
            self.watermarks_table.put_item(Item={
                'source': f"{self.source_platform}#{key}",
                'value': value,
                'updated_at': datetime.now(timezone.utc).isoformat()
            })
        except Exception as e:
            logger.error(f"Failed to save watermark: {e}")
    
    @abstractmethod
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from the data source. Must be implemented by subclasses."""
        pass
    
    def normalize_item(self, item: dict) -> dict:
        """Normalize item to common raw schema."""
        # Use source_platform_override if provided (e.g., scraper name), otherwise use default
        source_platform = item.get('source_platform_override', self.source_platform)
        return {
            'id': item.get('id', ''),
            'source_platform': source_platform,
            'source_channel': item.get('channel', 'unknown'),
            'url': item.get('url', ''),
            'text': item.get('text', ''),
            'rating': item.get('rating'),
            'created_at': item.get('created_at', datetime.now(timezone.utc).isoformat()),
            'ingested_at': datetime.now(timezone.utc).isoformat(),
            'brand_name': self.brand_name,
            'brand_handles_matched': item.get('brand_handles_matched', []),
            'raw_data': item
        }
    
    def send_to_queue(self, items: list[dict]):
        """Send items to SQS processing queue."""
        if not items:
            return
        
        # Send in batches of 10 (SQS limit)
        for i in range(0, len(items), 10):
            batch = items[i:i+10]
            entries = [
                {
                    'Id': str(idx),
                    'MessageBody': json.dumps(item, default=str)
                }
                for idx, item in enumerate(batch)
            ]
            
            sqs.send_message_batch(
                QueueUrl=PROCESSING_QUEUE_URL,
                Entries=entries
            )
        
        logger.info(f"Sent {len(items)} items to processing queue")
        metrics.add_metric(name="ItemsIngested", unit="Count", value=len(items))
    
    @tracer.capture_method
    def run(self) -> dict:
        """Main execution method."""
        items = []
        last_id = None
        
        try:
            for item in self.fetch_new_items():
                normalized = self.normalize_item(item)
                items.append(normalized)
                last_id = item.get('id')
                
                # Batch send every 100 items
                if len(items) >= 100:
                    self.send_to_queue(items)
                    items = []
            
            # Send remaining items
            if items:
                self.send_to_queue(items)
            
            # Update watermark
            if last_id:
                self.set_watermark('last_id', str(last_id))
            
            return {'status': 'success', 'items_processed': len(items)}
        
        except Exception as e:
            logger.exception(f"Ingestion failed: {e}")
            metrics.add_metric(name="IngestionErrors", unit="Count", value=1)
            raise
