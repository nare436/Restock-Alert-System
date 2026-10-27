# Microsoft Rewards Flipkart Restock Alert

A small Python service that can monitor a configured, **permitted availability source** and notify you by Telegram and/or email when the state changes to in stock. It never redeems points automatically.

Reward page: https://rewards.bing.com/redeem/sku/000885000034

## Important limitation

This repository does **not** assume Microsoft has a public or documented stock API. The default adapter deliberately returns `UNKNOWN` until a source is implemented and verified as permitted. It will not parse undocumented/private endpoints, reuse account cookies, bypass sign-in/CAPTCHA, or treat HTTP 200 as proof of stock.

Do not configure a one-minute polling frequency unless the data source permits it and the hosting platform supports it. GitHub Actions scheduled workflows are not suitable for reliable one-minute polling and can be delayed; the included workflow is a test runner, not a guaranteed stock checker.

## Architecture

```text
Permitted availability adapter
          |
          v
 IN_STOCK / OUT_OF_STOCK / UNKNOWN
          |
          v
 Transition + duplicate suppression
          |
          +----> Telegram Bot API (optional)
          |
          +----> SMTP email (optional)
```

## Local setup (Windows PowerShell)

1. Install Python 3.11 or later.
2. In this repository directory:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   Copy-Item .env.example .env
   ```

3. Edit `.env` and set the notification options. Keep it private; never commit it.
4. Run tests:

   ```powershell
   python -m unittest discover -s tests -v
   ```

5. Run one dry-run check:

   ```powershell
   python -m src.monitor --once
   ```

The default availability adapter returns `UNKNOWN`, by design. Notification test mode can be used without sending messages.

## Telegram setup

1. In Telegram, open **@BotFather**, create a bot, and copy its token.
2. Open your new bot and press **Start**.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. Never publish the token.
4. Set `NOTIFY_TELEGRAM=true`.
5. Test configuration using `python -m src.monitor --test-notification`.

The test notification is sent to the configured channel only when `DRY_RUN=false`; when dry-run is on, it logs what it would do without sending.

## Optional email setup

Configure `NOTIFY_EMAIL=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM`, and `EMAIL_TO`. For consumer mail providers, use their supported app-password/OAuth setup where required; don't use your normal password if the provider disallows it.

## Running the monitor locally

Once you have configured a permitted availability source and notification channels:

```powershell
python -m src.monitor --loop
```

The interval is at least 60 seconds, with exponential backoff for unknown/error results and respect for integer `Retry-After` values. Leave your computer on and connected; closing the terminal stops monitoring. Use `--once` for one check.

## GitHub Actions

The workflow runs unit tests and a manual smoke check. It intentionally does not run every minute. GitHub Actions schedules aren't a one-minute monitoring solution and may be delayed. Secrets can be added under **Settings → Secrets and variables → Actions**; never add credentials to the repository files.

## Configure a permitted JSON availability source

Edit `.env` only after verifying that you are authorized to poll the endpoint and have a documented response schema. Configure:

- `AVAILABILITY_MODE=json_api`
- `AVAILABILITY_URL=https://.../` — endpoint you are permitted to access without account cookies or bypasses.
- `AVAILABILITY_STATUS_PATH=item.stock` — dot-separated path to the explicit stock value in its JSON response.
- `IN_STOCK_VALUES` and `OUT_OF_STOCK_VALUES` — explicit values for the real schema.

The adapter makes an unauthenticated GET request with a timeout. It returns `UNKNOWN` on non-JSON responses, unrecognized values, HTTP errors, network failures, and rate limits. It never treats a bare HTTP 200 as in-stock proof.

## Files

- `src/availability.py`: status model and conservative JSON adapter.
- `src/notifier.py`: Telegram and SMTP implementations.
- `src/monitor.py`: state transitions, duplicate suppression, loop, CLI.
- `src/config.py`: environment configuration.
- `tests/`: unit tests with mocked responses.
- `.github/workflows/ci.yml`: CI/test workflow.

## Security

Never commit `.env`, bot tokens, email app passwords, Microsoft account credentials, browser cookies, or session tokens. The tool only sends notifications; it never redeems points.
