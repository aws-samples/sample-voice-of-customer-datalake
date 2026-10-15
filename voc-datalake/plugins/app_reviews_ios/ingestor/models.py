"""
App configuration validation for iOS App Reviews plugin.
"""

from dataclasses import dataclass


@dataclass
class IOSAppConfig:
    """Configuration for a single iOS app to collect reviews from."""
    name: str
    app_id: str
    enabled: bool = True
    max_reviews_per_run: int = 500

    @classmethod
    def from_dict(cls, data: dict) -> "IOSAppConfig":
        """Create from dictionary, with validation."""
        name = data.get("name", "").strip()
        if not name:
            raise ValueError("App config missing required field: name")

        app_id = str(data.get("app_id", "")).strip()
        if not app_id:
            raise ValueError(f"App '{name}' missing required field: app_id")

        return cls(
            name=name,
            app_id=app_id,
            enabled=data.get("enabled", True),
            max_reviews_per_run=int(data.get("max_reviews_per_run", 500)),
        )
