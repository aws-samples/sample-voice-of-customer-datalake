"""
App configuration model for iOS App Reviews plugin.
"""

from dataclasses import dataclass


@dataclass
class IOSAppConfig:
    """Configuration for a single iOS app to collect reviews from."""
    name: str
    app_id: str
    enabled: bool = True
    max_reviews_per_run: int = 500
