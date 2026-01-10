"""
Shared pytest fixtures for shared module tests.
"""
import os
import sys
import pytest
from unittest.mock import MagicMock

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Set environment variables
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'test-shared'
