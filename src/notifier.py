"""Telegram-only notifications for the local Python monitor."""

import logging
from urllib.parse import quote

import requests

from .config import Settings

log = logging.getLogger(__name__)


def alert_text(settings: Settings) -> str:
    return (
        "🎉 Microsoft Rewards restock alert\n\n"
        "The Flipkart gift card may be available. Verify on the official page and redeem manually. "
        "This alert is not a guarantee of live stock.\n\n"
        f"{settings.redemption_url}"
    )


def send_telegram(settings: Settings, message: str) -> bool:
    if not settings.notify_telegram:
        return False
    if not settings.telegram_bot_token or not settings.telegram_chat_id:
        log.error("Telegram enabled but bot token/chat ID is missing.")
        return False
    if settings.dry_run:
        log.info("DRY_RUN: would send Telegram notification.")
        return True

    endpoint = (
        "https://api.telegram.org/bot"
        + quote(settings.telegram_bot_token, safe=":")
        + "/sendMessage"
    )
    try:
        response = requests.post(
            endpoint,
            json={"chat_id": settings.telegram_chat_id, "text": message},
            timeout=10,
        )
        if response.status_code != 200:
            log.error("Telegram send failed with HTTP %s.", response.status_code)
            return False
        if response.json().get("ok") is not True:
            log.error("Telegram API did not confirm message delivery.")
            return False
        return True
    except (requests.RequestException, ValueError):
        log.exception("Telegram notification failed.")
        return False


def send_configured(
    settings: Settings,
    message: str,
    only_channels: tuple[str, ...] | None = None,
) -> dict[str, bool]:
    """Send only to Telegram; failed attempts can be retried on later checks."""
    if not settings.notify_telegram or (only_channels is not None and "telegram" not in only_channels):
        return {}
    return {"telegram": send_telegram(settings, message)}


def send_test_notification(settings: Settings) -> dict[str, bool]:
    return send_configured(
        settings,
        "🧪 Test notification from Restock Alert System. Telegram is configured; this is not a stock alert.\n\n"
        + settings.redemption_url,
    )
