import tempfile
import unittest
from pathlib import Path

from src.availability import AvailabilityResult, Status
from src.config import Settings
from src.monitor import process_result


def make_settings(**overrides):
    values = dict(
        redemption_url="https://rewards.bing.com/redeem/sku/000885000034",
        availability_mode="disabled",
        availability_url="",
        availability_status_path="",
        in_stock_values=("in_stock",),
        out_of_stock_values=("out_of_stock",),
        check_interval_seconds=60,
        request_timeout_seconds=5,
        state_file=Path("data/state.json"),
        dry_run=True,
        notify_telegram=True,
        telegram_bot_token="test-token",
        telegram_chat_id="123",
        notify_email=False,
        smtp_host="",
        smtp_port=587,
        smtp_username="",
        smtp_password="",
        email_from="",
        email_to="",
    )
    values.update(overrides)
    return Settings(**values)


class MonitorTests(unittest.TestCase):
    def test_alert_once_for_in_stock_until_out_of_stock(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            calls = []

            def sender(settings, message, channels):
                calls.append(message)
                return {"telegram": True}

            process_result(
                make_settings(), AvailabilityResult(Status.IN_STOCK), state_path=state_path,
                notification_sender=sender,
            )
            process_result(
                make_settings(), AvailabilityResult(Status.IN_STOCK), state_path=state_path,
                notification_sender=sender,
            )
            self.assertEqual(len(calls), 1)

            process_result(
                make_settings(), AvailabilityResult(Status.OUT_OF_STOCK), state_path=state_path,
                notification_sender=sender,
            )
            process_result(
                make_settings(), AvailabilityResult(Status.IN_STOCK), state_path=state_path,
                notification_sender=sender,
            )
            self.assertEqual(len(calls), 2)

    def test_failed_channel_is_retried_without_repeating_successful_channel(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            calls = []

            def sender(settings, message, channels):
                calls.append(1)
                # Telegram succeeded, email failed.
                return {"telegram": True, "email": False}

            config = make_settings(notify_email=True, email_from="a@example.com", email_to="b@example.com")
            process_result(config, AvailabilityResult(Status.IN_STOCK), state_path=state_path, notification_sender=sender)
            process_result(config, AvailabilityResult(Status.IN_STOCK), state_path=state_path, notification_sender=sender)
            # sender is invoked to retry pending email; Telegram's delivery is tracked.
            self.assertEqual(len(calls), 2)
            import json
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(state["notified_channels"], ["telegram"])

    def test_unknown_does_not_overwrite_existing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.json"
            process_result(
                make_settings(), AvailabilityResult(Status.OUT_OF_STOCK), state_path=state_path,
                notification_sender=lambda *_: {},
            )
            previous = state_path.read_text(encoding="utf-8")
            process_result(
                make_settings(), AvailabilityResult(Status.UNKNOWN), state_path=state_path,
                notification_sender=lambda *_: {},
            )
            self.assertEqual(state_path.read_text(encoding="utf-8"), previous)


if __name__ == "__main__":
    unittest.main()
