"""Availability adapters.

The safe default is UNKNOWN. A JSON endpoint can only be configured after verifying
that it is documented/permitted to access and poll. This module sends no account
cookies, credentials, or browser session data.
"""

from dataclasses import dataclass
from enum import Enum
import logging
from typing import Any

import requests

from .config import Settings

log = logging.getLogger(__name__)


class Status(str, Enum):
    IN_STOCK = "IN_STOCK"
    OUT_OF_STOCK = "OUT_OF_STOCK"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class AvailabilityResult:
    status: Status
    detail: str = ""
    retry_after_seconds: int | None = None


def _read_path(document: Any, dotted_path: str) -> Any:
    """Read a dot-separated path from nested dicts; no eval or dynamic code."""
    value = document
    if not dotted_path:
        raise ValueError("AVAILABILITY_STATUS_PATH is not configured")
    for component in dotted_path.split("."):
        if not isinstance(value, dict) or component not in value:
            raise KeyError(f"Missing JSON field: {component}")
        value = value[component]
    return value


def check_availability(settings: Settings) -> AvailabilityResult:
    """Check a deliberately configured, unauthenticated JSON endpoint."""
    if settings.availability_mode != "json_api":
        return AvailabilityResult(
            Status.UNKNOWN,
            "No verified availability source configured; no request was made.",
        )
    if not settings.availability_url or not settings.availability_status_path:
        return AvailabilityResult(
            Status.UNKNOWN,
            "JSON_API mode requires AVAILABILITY_URL and AVAILABILITY_STATUS_PATH.",
        )

    try:
        response = requests.get(
            settings.availability_url,
            headers={
                "Accept": "application/json",
                "User-Agent": "PersonalRestockAlert/1.0 (availability monitor)",
            },
            timeout=settings.request_timeout_seconds,
            allow_redirects=True,
        )
    except requests.RequestException as exc:
        log.warning("Availability request failed: %s", type(exc).__name__)
        return AvailabilityResult(Status.UNKNOWN, "Network request failed.")

    if response.status_code == 429:
        retry_after = response.headers.get("Retry-After", "")
        retry_seconds = None
        try:
            retry_seconds = max(1, int(retry_after))
        except (TypeError, ValueError):
            pass
        return AvailabilityResult(Status.UNKNOWN, "Rate limited (HTTP 429).", retry_seconds)

    if response.status_code != 200:
        return AvailabilityResult(Status.UNKNOWN, f"Unexpected HTTP status {response.status_code}.")

    content_type = response.headers.get("Content-Type", "").lower()
    if "json" not in content_type:
        return AvailabilityResult(Status.UNKNOWN, "Response was not declared as JSON.")

    try:
        payload = response.json()
        value = _read_path(payload, settings.availability_status_path)
    except (ValueError, KeyError, TypeError):
        return AvailabilityResult(Status.UNKNOWN, "Could not parse configured status field.")

    normalized = str(value).strip().lower()
    if normalized in settings.in_stock_values:
        return AvailabilityResult(Status.IN_STOCK, "Configured field explicitly indicates availability.")
    if normalized in settings.out_of_stock_values:
        return AvailabilityResult(Status.OUT_OF_STOCK, "Configured field explicitly indicates no availability.")
    return AvailabilityResult(Status.UNKNOWN, "Status value did not match configured values.")
