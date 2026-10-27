"""Environment-based configuration for the restock alert."""

from dataclasses import dataclass
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str, default: str) -> tuple[str, ...]:
    return tuple(part.strip().lower() for part in os.getenv(name, default).split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    redemption_url: str
    availability_mode: str
    availability_url: str
    availability_status_path: str
    in_stock_values: tuple[str, ...]
    out_of_stock_values: tuple[str, ...]
    check_interval_seconds: int
    request_timeout_seconds: int
    state_file: Path
    dry_run: bool
    notify_telegram: bool
    telegram_bot_token: str
    telegram_chat_id: str
    notify_email: bool
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    email_from: str
    email_to: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            redemption_url=os.getenv(
                "REDEMPTION_URL",
                "https://rewards.bing.com/redeem/sku/000885000034",
            ),
            availability_mode=os.getenv("AVAILABILITY_MODE", "disabled").strip().lower(),
            availability_url=os.getenv("AVAILABILITY_URL", "").strip(),
            availability_status_path=os.getenv("AVAILABILITY_STATUS_PATH", "").strip(),
            in_stock_values=_csv("IN_STOCK_VALUES", "in_stock,available,true,1"),
            out_of_stock_values=_csv("OUT_OF_STOCK_VALUES", "out_of_stock,unavailable,false,0"),
            check_interval_seconds=max(60, int(os.getenv("CHECK_INTERVAL_SECONDS", "60"))),
            request_timeout_seconds=max(2, int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))),
            state_file=Path(os.getenv("STATE_FILE", "data/state.json")),
            dry_run=_bool("DRY_RUN", True),
            notify_telegram=_bool("NOTIFY_TELEGRAM", False),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID", "").strip(),
            notify_email=_bool("NOTIFY_EMAIL", False),
            smtp_host=os.getenv("SMTP_HOST", "").strip(),
            smtp_port=int(os.getenv("SMTP_PORT", "587")),
            smtp_username=os.getenv("SMTP_USERNAME", "").strip(),
            smtp_password=os.getenv("SMTP_PASSWORD", ""),
            email_from=os.getenv("EMAIL_FROM", "").strip(),
            email_to=os.getenv("EMAIL_TO", "").strip(),
        )

    def enabled_channels(self) -> tuple[str, ...]:
        channels: list[str] = []
        if self.notify_telegram:
            channels.append("telegram")
        if self.notify_email:
            channels.append("email")
        return tuple(channels)
