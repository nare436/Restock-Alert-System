# Microsoft Rewards Flipkart Restock Alert

A small Python service that can monitor a configured, **permitted availability source** and notify you by Telegram and/or email when the state changes to in stock. It never redeems points automatically.

Reward page: https://rewards.bing.com/redeem/sku/000885000034

## Important limitation

This repository does **not** assume Microsoft has a public or documented stock API. The default adapter deliberately returns `UNKNOWN` until a source is implemented and verified as permitted. It will not parse undocumented/private endpoints, reuse account cookies, bypass sign-in/CAPTCHA, or treat HTTP 200 as proof of stock.

Do not configure a three-minute polling frequency unless the data source permits it and the hosting platform supports it. GitHub Actions scheduled workflows are not suitable for reliable three-minute polling and can be delayed; the included workflow is a test runner, not a guaranteed stock checker.

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

The Python loop interval is at least 180 seconds (3 minutes), with exponential backoff for unknown/error results and respect for integer `Retry-After` values. Leave your computer on and connected; closing the terminal stops monitoring. Use `--once` for one check.

## GitHub Actions

The workflow runs unit tests and a manual smoke check. It intentionally does not run every three minutes. GitHub Actions schedules aren't a three-minute monitoring solution and may be delayed. Secrets can be added under **Settings → Secrets and variables → Actions**; never add credentials to the repository files.

## Configure a permitted JSON availability source

Edit `.env` only after verifying that you are authorized to poll the endpoint and have a documented response schema. Configure:

- `AVAILABILITY_MODE=json_api`
- `AVAILABILITY_URL=https://.../` — endpoint you are permitted to access without account cookies or bypasses.
- `AVAILABILITY_STATUS_PATH=item.stock` — dot-separated path to the explicit stock value in its JSON response.
- `IN_STOCK_VALUES` and `OUT_OF_STOCK_VALUES` — explicit values for the real schema.

The adapter makes an unauthenticated GET request with a timeout. It returns `UNKNOWN` on non-JSON responses, unrecognized values, HTTP errors, network failures, and rate limits. It never treats a bare HTTP 200 as in-stock proof.

## Telegram commands

After configuring the Telegram webhook (steps below), open the bot and send:

- `/check` — performs an availability check immediately, then replies with `IN STOCK`, `OUT OF STOCK`, or `UNKNOWN`.
- `/status` — shows the most recent check result and when it ran.
- `/help` — shows the available commands.

Scheduled Cloudflare checks run every 3 minutes. A manual `/check` is on demand, but it still respects any rate limit or `Retry-After` instruction from the availability source. Commands are restricted to the private Telegram chat ID in `TELEGRAM_CHAT_ID`.

## Connect Telegram commands to Cloudflare

The Worker endpoint is `/telegram`. It requires a Telegram webhook secret and only accepts commands from the chat ID configured in `TELEGRAM_CHAT_ID`.

1. In Cloudflare, run from the repository folder in PowerShell:

   ```powershell
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   When prompted, paste each value directly into the terminal, not into GitHub files or this chat. Generate the webhook secret with `[guid]::NewGuid().ToString("N")` in PowerShell and keep a copy for the next step. The bot token is obtained from **@BotFather**. The chat ID is the number for your private conversation with your bot.

2. Deploy the Worker after configuring the KV namespace ID in `wrangler.toml`:

   ```powershell
   npx wrangler deploy
   ```

3. Register Telegram's webhook using PowerShell (the Worker URL is shown by Wrangler after deployment). The commands below ask you to paste the token and webhook secret interactively, so the token does not need to be hardcoded in the script:

   ```powershell
   $botToken = Read-Host "Paste Telegram bot token"
   $webhookSecret = Read-Host "Paste the same webhook secret used in Cloudflare"
   $workerUrl = Read-Host "Paste your deployed Worker URL (https://...)"
   $body = @{
     url = "$($workerUrl.TrimEnd('/'))/telegram"
     secret_token = $webhookSecret
     allowed_updates = @("message")
   } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setWebhook" -ContentType "application/json" -Body $body
   Remove-Variable botToken, webhookSecret
   ```

   Telegram should return `ok: true`. Then open your bot and send `/start`, followed by `/status`.

4. Optional: use **@BotFather** → `/setcommands` to show the commands in Telegram's menu. Select the bot and paste:

   ```text
   start - Show help
   help - Show available commands
   status - Show latest availability check
   check - Check availability now
   ```

This creates the bot webhook; it does not configure a Microsoft stock endpoint. Until a documented/permitted availability source is configured, manual `/check` correctly reports `UNKNOWN`, not a false stock result.

## Files

- `src/availability.py`: status model and conservative JSON adapter.
- `src/notifier.py`: Telegram and SMTP implementations.
- `src/monitor.py`: state transitions, duplicate suppression, loop, CLI.
- `src/config.py`: environment configuration.
- `tests/`: unit tests with mocked responses.
- `.github/workflows/ci.yml`: CI/test workflow.

## Free every-three-minutes Cloudflare deployment

Cloudflare Workers Cron Triggers support `* * * * *` (every three minutes) on the Free plan. This repository includes an alternate Worker entry point at `cloudflare/worker.js` and `wrangler.toml`. The hosted Worker sends Telegram alerts; the Python version remains useful for local monitoring and optional SMTP email.

1. Install Node.js LTS from https://nodejs.org/ and open PowerShell in the project directory.
2. Install and sign in to Wrangler:

   ```powershell
   npx wrangler login
   ```

3. Create the state namespace:

   ```powershell
   npx wrangler kv namespace create ALERT_STATE
   ```

   Copy the returned namespace ID into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

4. Create a Telegram bot with @BotFather, start a chat with it, and obtain your chat ID. Configure secrets:

   ```powershell
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

   Enter the value when Wrangler prompts. Never commit either value.

5. Keep `AVAILABILITY_MODE = "disabled"` until you have verified a documented/permitted JSON stock source. Then edit `AVAILABILITY_MODE`, `AVAILABILITY_URL`, `AVAILABILITY_STATUS_PATH`, and the explicit stock-value lists in `wrangler.toml`.
6. Deploy:

   ```powershell
   npx wrangler deploy
   ```

7. Open Cloudflare Dashboard → Workers & Pages → your Worker → Settings/Triggers and confirm the Cron Trigger is `* * * * *`. Check **Logs** after scheduled runs.

The Worker reads state from a KV namespace. Cloudflare's free KV allowance currently includes 100,000 reads/day and 1,000 writes/day; this Worker writes state mainly on status changes or when rate-limited. KV is eventually consistent, so avoid deploying multiple copies of the same monitor and understand that a short delay or rare duplicate is possible. Source-side rate limits still take priority over checking every three minutes.

**Do not set an endpoint URL until you have verified that automated polling is permitted.** The Worker performs unauthenticated GET requests only and never uses Microsoft account cookies, sessions, passwords, or CAPTCHA bypasses. It treats unclear responses as `UNKNOWN` and will not send an availability alert.

## Security

Never commit `.env`, bot tokens, email app passwords, Microsoft account credentials, browser cookies, or session tokens. The tool only sends notifications; it never redeems points.
