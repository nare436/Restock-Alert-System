"""Optional Telegram and SMTP notifications."""

from email.message import EmailMessage
import logging
import smtplib
import ssl
from urllib.parse import quote

import requests

from .config import Settings

log = logging.getLogger(__name__)


def alert_text(settings: Settings) -> str:
    return (
        "🎉 Microsoft Rewards restock alert\n\n"
        "The Flipkart gift card may be available. Verify on the official page "
        "and redeem manually. This alert is not a guarantee of live stock.\n\n"
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
        body = response.json()
        if body.get("ok") is not True:
            log.error("Telegram API did not confirm message delivery.")
            return False
        return True
    except (requests.RequestException, ValueError):
        log.exception("Telegram notification failed.")
        return False


def send_email(settings: Settings, message: str, subject: str = "Microsoft Rewards Flipkart Restock Alert") -> bool:
    if not settings.notify_email:
        return False
    required = (
        settings.smtp_host,
        settings.email_from,
        settings.email_to,
    )
    if not all(required):
        log.error("Email enabled but SMTP host/from/to is missing.")
        return False
    if settings.dry_run:
        log.info("DRY_RUN: would send email to configured recipient.")
        return True

    email = EmailMessage()
    email["Subject"] = subject
    email["From"] = settings.email_from
    email["To"] = settings.email_to
    email.set_content(message)

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            server.ehlo()
            if server.has_extn("starttls"):
                server.starttls(context=context)
                server.ehlo()
            if settings.smtp_username:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(email)
        return True
    except (OSError, smtplib.SMTPException):
        log.exception("Email notification failed.")
        return False


def send_configured(
    settings: Settings,
    message: str,
    only_channels: tuple[str, ...] | None = None,
) -> dict[str, bool]:
    """Send only selected channels; failed channels can be retried without duplicates."""
    results: dict[str, bool] = {}
    if settings.notify_telegram and (only_channels is None or "telegram" in only_channels):
        results["telegram"] = send_telegram(settings, message)
    if settings.notify_email and (only_channels is None or "email" in only_channels):
        results["email"] = send_email(settings, message)
    return results


def send_test_notification(settings: Settings) -> dict[str, bool]:
    return send_configured(
        settings,
        "🧪 Test notification from Restock Alert System. Notifications are configured; "
        "this is not a stock availability claim.\n\n" + settings.redemption_url,
    )
