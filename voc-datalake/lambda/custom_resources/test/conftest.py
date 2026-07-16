"""
Pytest fixtures for custom resource handler tests.
"""
import os
import sys

# Make the handler module importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# boto3.client() at module import needs a region
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
