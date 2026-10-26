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
    # The Radar brand key its reviews go to (docs/radar.md); empty for one of our own apps.
    radar_brand: str = ''
