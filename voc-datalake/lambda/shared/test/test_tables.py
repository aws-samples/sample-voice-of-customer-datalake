"""
Tests for shared/tables.py - DynamoDB table accessors.
"""
import os
import pytest
from unittest.mock import MagicMock, patch


class TestGetJobsTable:
    """Tests for get_jobs_table function."""
    
    def setup_method(self):
        """Reset module state before each test."""
        # Clear cached tables
        import shared.tables as tables_module
        tables_module._jobs_table = None
        tables_module._aggregates_table = None
        tables_module._feedback_table = None
        tables_module._projects_table = None
    
    def test_returns_none_when_env_not_set(self):
        """Should return None when JOBS_TABLE env var is not set."""
        from shared.tables import get_jobs_table, clear_table_cache
        clear_table_cache()
        
        with patch.dict(os.environ, {'JOBS_TABLE': ''}, clear=False):
            result = get_jobs_table()
            assert result is None
    
    @patch('shared.tables.get_dynamodb_resource')
    def test_returns_table_when_env_set(self, mock_get_dynamodb):
        """Should return table when JOBS_TABLE env var is set."""
        from shared.tables import get_jobs_table, clear_table_cache
        clear_table_cache()
        
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_get_dynamodb.return_value = mock_dynamodb
        
        with patch.dict(os.environ, {'JOBS_TABLE': 'test-jobs-table'}, clear=False):
            result = get_jobs_table()
            
            assert result == mock_table
            mock_dynamodb.Table.assert_called_once_with('test-jobs-table')
    
    @patch('shared.tables.get_dynamodb_resource')
    def test_caches_table_reference(self, mock_get_dynamodb):
        """Should cache table reference and reuse it."""
        from shared.tables import get_jobs_table, clear_table_cache
        clear_table_cache()
        
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_get_dynamodb.return_value = mock_dynamodb
        
        with patch.dict(os.environ, {'JOBS_TABLE': 'test-jobs-table'}, clear=False):
            result1 = get_jobs_table()
            result2 = get_jobs_table()
            
            assert result1 is result2
            # Table should only be created once
            assert mock_dynamodb.Table.call_count == 1


class TestGetAggregatesTable:
    """Tests for get_aggregates_table function."""
    
    def setup_method(self):
        """Reset module state before each test."""
        from shared.tables import clear_table_cache
        clear_table_cache()
    
    def test_returns_none_when_env_not_set(self):
        """Should return None when AGGREGATES_TABLE env var is not set."""
        from shared.tables import get_aggregates_table
        
        with patch.dict(os.environ, {'AGGREGATES_TABLE': ''}, clear=False):
            result = get_aggregates_table()
            assert result is None
    
    @patch('shared.tables.get_dynamodb_resource')
    def test_returns_table_when_env_set(self, mock_get_dynamodb):
        """Should return table when AGGREGATES_TABLE env var is set."""
        from shared.tables import get_aggregates_table, clear_table_cache
        clear_table_cache()
        
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_get_dynamodb.return_value = mock_dynamodb
        
        with patch.dict(os.environ, {'AGGREGATES_TABLE': 'test-aggregates-table'}, clear=False):
            result = get_aggregates_table()
            
            assert result == mock_table
            mock_dynamodb.Table.assert_called_once_with('test-aggregates-table')


class TestClearTableCache:
    """Tests for clear_table_cache function."""
    
    @patch('shared.tables.get_dynamodb_resource')
    def test_clears_all_cached_tables(self, mock_get_dynamodb):
        """Should clear all cached table references."""
        from shared.tables import (
            get_jobs_table, get_aggregates_table, 
            get_feedback_table, get_projects_table,
            clear_table_cache
        )
        
        # Start fresh
        clear_table_cache()
        
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_get_dynamodb.return_value = mock_dynamodb
        
        with patch.dict(os.environ, {
            'JOBS_TABLE': 'jobs',
            'AGGREGATES_TABLE': 'aggregates',
            'FEEDBACK_TABLE': 'feedback',
            'PROJECTS_TABLE': 'projects'
        }, clear=False):
            # Initialize all tables
            get_jobs_table()
            get_aggregates_table()
            get_feedback_table()
            get_projects_table()
            
            initial_count = mock_dynamodb.Table.call_count
            assert initial_count == 4
            
            # Clear cache
            clear_table_cache()
            
            # Get tables again - should create new ones
            get_jobs_table()
            get_aggregates_table()
            
            # Should have 2 more calls after clearing
            assert mock_dynamodb.Table.call_count == initial_count + 2
