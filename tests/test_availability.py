import unittest
from unittest.mock import Mock, patch

import requests

from src.availability import Status, check_availability
from src.config import Settings


def settings(**overrides):
    values = dict(
        redemption_url="https://rewards.bing.com/redeem/sku/000885000034",
        availability_mode="json_api",
        availability_url="https://example.test/status",
        availability_status_path="item.stock",
        in_stock_values=("in_stock", "available", "true", "1"),
        out_of_stock_values=("out_of_stock", "unavailable", "false", "0"),
        check_interval_seconds=60,
        request_timeout_seconds=5,
        state_file=__import__("pathlib").Path("data/test-state.json"),
        dry_run=True,
        notify_telegram=False,
        telegram_bot_token="",
        telegram_chat_id="",
    )
    values.update(overrides)
    return Settings(**values)


class AvailabilityTests(unittest.TestCase):
    @patch("src.availability.requests.get")
    def test_in_stock_when_configured_json_field_matches(self, get):
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "application/json"}
        response.json.return_value = {"item": {"stock": "available"}}
        get.return_value = response
        result = check_availability(settings())
        self.assertEqual(result.status, Status.IN_STOCK)

    @patch("src.availability.requests.get")
    def test_out_of_stock(self, get):
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "application/json"}
        response.json.return_value = {"item": {"stock": "unavailable"}}
        get.return_value = response
        self.assertEqual(check_availability(settings()).status, Status.OUT_OF_STOCK)

    @patch("src.availability.requests.get")
    def test_unknown_for_unrecognized_value(self, get):
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "application/json"}
        response.json.return_value = {"item": {"stock": "maybe"}}
        get.return_value = response
        self.assertEqual(check_availability(settings()).status, Status.UNKNOWN)

    @patch("src.availability.requests.get")
    def test_429_honors_retry_after(self, get):
        response = Mock(status_code=429)
        response.headers = {"Retry-After": "120"}
        get.return_value = response
        result = check_availability(settings())
        self.assertEqual(result.status, Status.UNKNOWN)
        self.assertEqual(result.retry_after_seconds, 120)

    @patch("src.availability.requests.get", side_effect=requests.Timeout())
    def test_network_failure_is_unknown(self, _get):
        self.assertEqual(check_availability(settings()).status, Status.UNKNOWN)

    @patch("src.availability.requests.get")
    def test_non_json_is_unknown(self, get):
        response = Mock(status_code=200)
        response.headers = {"Content-Type": "text/html"}
        get.return_value = response
        self.assertEqual(check_availability(settings()).status, Status.UNKNOWN)

    def test_disabled_source_does_not_make_request(self):
        config = settings(availability_mode="disabled")
        with patch("src.availability.requests.get") as get:
            self.assertEqual(check_availability(config).status, Status.UNKNOWN)
            get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
