"""CLI and monitoring loop."""

import argparse
import json
import logging
import time
from pathlib import Path
from typing import Any

from .availability import AvailabilityResult, Status, check_availability
from .config import Settings
from .notifier import alert_text, send_configured, send_test_notification

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


def _load_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError):
        log.warning("State file could not be read; starting with empty state.")
    return {"last_status": None, "notified_channels": []}


def _save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temporary.replace(path)


def process_result(
    settings: Settings,
    result: AvailabilityResult,
    *,
    state_path: Path | None = None,
    notification_sender=send_configured,
) -> dict[str, Any]:
    """Process one check. Tracks per-channel success to limit duplicate alerts."""
    path = state_path or settings.state_file
    state = _load_state(path)
    last_status = state.get("last_status")
    notified = set(state.get("notified_channels", []))

    log.info("Availability: %s — %s", result.status.value, result.detail)

    if result.status == Status.UNKNOWN:
        return state

    if result.status == Status.OUT_OF_STOCK:
        state = {"last_status": Status.OUT_OF_STOCK.value, "notified_channels": []}
        _save_state(path, state)
        return state

    # On the initial known IN_STOCK check, alert too: there is no previous state.
    if last_status != Status.IN_STOCK.value:
        notified = set()

    enabled = settings.enabled_channels()
    if not enabled:
        log.warning("IN_STOCK detected, but no notification channel is enabled.")
        state = {"last_status": Status.IN_STOCK.value, "notified_channels": []}
        _save_state(path, state)
        return state

    pending = [channel for channel in enabled if channel not in notified]
    if pending:
        results = notification_sender(settings, alert_text(settings))
        for channel in pending:
            # A channel is recorded only if it was attempted and confirmed successful.
            if results.get(channel) is True:
                notified.add(channel)

    state = {
        "last_status": Status.IN_STOCK.value,
        "notified_channels": sorted(notified),
    }
    _save_state(path, state)
    return state


def run_once(settings: Settings) -> AvailabilityResult:
    result = check_availability(settings)
    process_result(settings, result)
    return result


def run_loop(settings: Settings) -> None:
    consecutive_unknowns = 0
    while True:
        started = time.monotonic()
        result = run_once(settings)
        if result.status == Status.UNKNOWN:
            consecutive_unknowns += 1
            backoff = min(900, settings.check_interval_seconds * (2 ** min(consecutive_unknowns - 1, 4)))
            if result.retry_after_seconds is not None:
                backoff = max(backoff, result.retry_after_seconds)
            delay = backoff
        else:
            consecutive_unknowns = 0
            delay = settings.check_interval_seconds
        # Keep a minimum delay and avoid busy loops if a check completes quickly.
        elapsed = time.monotonic() - started
        time.sleep(max(1, delay - elapsed))


def main() -> int:
    parser = argparse.ArgumentParser(description="Microsoft Rewards Flipkart gift-card restock notifier")
    parser.add_argument("--once", action="store_true", help="perform one check and exit")
    parser.add_argument("--loop", action="store_true", help="monitor continuously (local machine/always-on host)")
    parser.add_argument("--test-notification", action="store_true", help="send a test message to enabled channels")
    args = parser.parse_args()
    settings = Settings.from_env()

    if args.test_notification:
        results = send_test_notification(settings)
        if not results:
            log.error("No notification channels enabled.")
            return 2
        return 0 if all(results.values()) else 1

    if args.loop:
        run_loop(settings)
        return 0

    # Default is a single safe check; --once is accepted for clarity.
    run_once(settings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
