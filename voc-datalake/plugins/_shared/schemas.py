"""
Pydantic schemas for message validation.

These schemas validate messages from plugins before they enter the processing pipeline.
This acts as a security boundary between untrusted plugin output and trusted processing.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from pydantic import BaseModel, Field, field_validator, model_validator


# ============================================
# Constants
# ============================================

MAX_TEXT_LENGTH = 50_000  # 50KB max for feedback text
MAX_ID_LENGTH = 256
MAX_URL_LENGTH = 2048
MAX_METADATA_KEYS = 20
MAX_METADATA_VALUE_LENGTH = 1000

# Known plugin IDs (for validation)
KNOWN_SOURCES = {
    "webscraper", "s3_import", "manual_import",
    "app_reviews_ios", "app_reviews_android",
}


# ============================================
# Exceptions
# ============================================

class MessageValidationError(Exception):
    """Raised when message validation fails."""
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Validation failed: {', '.join(errors)}")


# ============================================
# Metadata Schema
# ============================================

class MessageMetadata(BaseModel):
    """
    Flat metadata with primitive values only.
    No nested objects allowed for security.
    """
    model_config = {"extra": "allow"}  # Allow additional fields
    
    # Common metadata fields
    is_verified: Optional[bool] = None
    location_id: Optional[str] = Field(None, max_length=64)
    reference_id: Optional[str] = Field(None, max_length=64)
    reply_count: Optional[int] = Field(None, ge=0)
    like_count: Optional[int] = Field(None, ge=0)
    business_id: Optional[str] = Field(None, max_length=128)
    business_name: Optional[str] = Field(None, max_length=256)
    author_image: Optional[str] = Field(None, max_length=512)

    @model_validator(mode="before")
    @classmethod
    def validate_all_values_primitive(cls, values):
        """Ensure all values are primitives (no nested objects)."""
        if not isinstance(values, dict):
            return values
        
        errors = []
        for key, value in values.items():
            # Check key format
            if not isinstance(key, str):
                errors.append(f"metadata key must be string, got {type(key)}")
                continue
            if len(key) > 64:
                errors.append(f"metadata key '{key[:20]}...' exceeds max length")
            
            # Check value is primitive
            if value is None:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                continue
            if isinstance(value, str):
                if len(value) > MAX_METADATA_VALUE_LENGTH:
                    errors.append(f"metadata value for '{key}' exceeds max length")
                continue
            
            # Reject nested objects, arrays, etc.
            errors.append(f"metadata value for '{key}' must be primitive (string, number, boolean, null)")
        
        if errors:
            raise ValueError("; ".join(errors))
        
        return values


# ============================================
# Message Schema
# ============================================

class IngestMessage(BaseModel):
    """Schema for messages sent to processing queue."""
    model_config = {"extra": "forbid"}  # Reject unknown fields
    
    # Required fields
    id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    source_platform: str = Field(..., pattern=r"^[a-z][a-z0-9_]*$")
    text: str = Field(..., min_length=1, max_length=MAX_TEXT_LENGTH)
    created_at: datetime
    
    # Optional fields
    rating: Optional[float] = Field(None, ge=1, le=5)
    url: Optional[str] = Field(None, max_length=MAX_URL_LENGTH)
    source_channel: Optional[str] = Field(None, max_length=64)
    channel: Optional[str] = Field(None, max_length=64)  # Alias for source_channel
    author: Optional[str] = Field(None, max_length=256)
    title: Optional[str] = Field(None, max_length=500)
    language: Optional[str] = Field(None, pattern=r"^[a-z]{2}(-[A-Z]{2})?$")
    brand_name: Optional[str] = Field(None, max_length=256)
    brand_handles_matched: Optional[list[str]] = Field(None, max_length=10)
    metadata: Optional[MessageMetadata] = None
    
    # Internal fields (set by platform)
    ingested_at: Optional[datetime] = None
    s3_raw_uri: Optional[str] = Field(None, max_length=512)
    raw_data: Optional[dict] = None
    is_webhook: Optional[bool] = None
    is_update: Optional[bool] = None
    is_deleted: Optional[bool] = None

    @field_validator("id", "source_platform", "source_channel", "channel", "author", "title")
    @classmethod
    def sanitize_string(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Remove control characters
        v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", v)
        return v.strip()

    @field_validator("text")
    @classmethod
    def sanitize_text(cls, v: str) -> str:
        # Remove control characters except newlines/tabs
        v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", v)
        # Normalize excessive newlines
        v = re.sub(r"\n{3,}", "\n\n", v)
        return v.strip()

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        if not v.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        return v

    @model_validator(mode="after")
    def validate_created_at_not_future(self) -> "IngestMessage":
        """Ensure created_at is not too far in the future."""
        if self.created_at.tzinfo is None:
            # Assume UTC if no timezone
            self.created_at = self.created_at.replace(tzinfo=timezone.utc)
        
        now = datetime.now(timezone.utc)
        if self.created_at > now + timedelta(days=1):
            raise ValueError("created_at cannot be more than 1 day in the future")
        return self


# ============================================
# Validation Functions
# ============================================

def validate_message(raw: dict) -> IngestMessage:
    """
    Validate and parse a raw message.
    
    Args:
        raw: Raw message dictionary from plugin
        
    Returns:
        Validated IngestMessage
        
    Raises:
        MessageValidationError: If validation fails
    """
    from pydantic import ValidationError
    
    try:
        return IngestMessage.model_validate(raw)
    except ValidationError as e:
        errors = [f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()]
        raise MessageValidationError(errors)


def safe_validate_message(raw: dict) -> tuple[Optional[IngestMessage], list[str]]:
    """
    Safely validate a message, returning errors instead of raising.
    
    Args:
        raw: Raw message dictionary from plugin
        
    Returns:
        Tuple of (validated message or None, list of errors)
    """
    try:
        msg = validate_message(raw)
        return msg, []
    except MessageValidationError as e:
        return None, e.errors
