# Microsoft Rewards Flipkart Restock Alert

A Python + Cloudflare Worker restock monitor that can notify you by Telegram and Gmail when a configured, **permitted availability source** reports in-stock. Telegram commands include /check, /status, /testemail, and /help. It never redeems points automatically.

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
          +----> Telegram Bot API (commands + alerts)
          +----> Google Apps Script MailApp -> Gmail (alerts)
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

- `/check` — performs a permitted availability check immediately, then replies with `IN STOCK`, `OUT OF STOCK`, or `UNKNOWN`.
- `/status` — shows the most recent check result and when it ran.
- `/testemail` — sends a test email to the fixed recipient configured in Google Apps Script.
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

## Gmail alerts using Google Apps Script (free)

The Cloudflare Worker cannot use ordinary Gmail SMTP directly. This project therefore includes `google-apps-script/Code.gs`, a small Google Apps Script relay that sends two fixed kinds of mail using your Gmail/Google account. It never reads your inbox and only sends to the single recipient saved in Script Properties.

1. Open [Google Apps Script](https://script.google.com/) while signed into the Gmail account you use to send email, then choose **New project**.
2. Open the repository file [`google-apps-script/Code.gs`](https://github.com/nare436/Restock-Alert-System/blob/main/google-apps-script/Code.gs), copy the entire code, and paste it into the Apps Script editor, replacing the starter code. Save the project.
3. In Apps Script, open **Project Settings** (gear icon) → **Script Properties** → **Add script property**, and create these three entries:
   - `EMAIL_TO` = the email address that should receive alerts.
   - `EMAIL_RELAY_SECRET` = a strong secret you generate locally. Do not use your Gmail password.
   - `REDEMPTION_URL` = `https://rewards.bing.com/redeem/sku/000885000034`
4. In the editor's function dropdown, choose `authorizeMailPermissions` and click **Run**. Accept Google's requested mail-sending permission. This function does not send an email.
5. Click **Deploy → New deployment → Select type → Web app**. Set **Execute as: Me**. Choose the least restrictive access option that your personal account permits (the worker must be able to call the endpoint anonymously); use this only because requests are protected by the shared secret. Click **Deploy** and approve any Google permission prompts. Copy the deployed URL ending in `/exec`.
6. Keep the relay URL and secret private. Do not place them in the repository or this chat.

### Add private values to Cloudflare

Run these commands in the same PowerShell window used for Wrangler; each command will prompt you to enter a value. Paste the value only into that prompt:

```powershell
npx wrangler secret put EMAIL_RELAY_URL
npx wrangler secret put EMAIL_RELAY_SECRET
```

For `EMAIL_RELAY_URL`, enter the deployed Apps Script URL ending in `/exec`. For `EMAIL_RELAY_SECRET`, enter the exact same value you saved as the Apps Script `EMAIL_RELAY_SECRET` property.

Then deploy the current code:

```powershell
npx wrangler deploy
```

After the Telegram webhook is registered, send `/testemail` to your bot. You should receive a test email. The relay never accepts a recipient address from the incoming request; the fixed `EMAIL_TO` script property controls where email goes. The endpoint URL is publicly reachable when anonymous access is enabled, so keep the secret strong and private. Google Apps Script quotas and account security controls apply.

## Files

- `src/availability.py`: status model and conservative JSON adapter.
- `src/notifier.py`: Telegram and SMTP implementations.
- `src/monitor.py`: state transitions, duplicate suppression, loop, CLI.
- `src/config.py`: environment configuration.
- `tests/`: unit tests with mocked responses.
- `.github/workflows/ci.yml`: CI/test workflow.

## Free every-three-minutes Cloudflare deployment

Cloudflare Workers Cron Triggers support `*/3 * * * *` (every three minutes) on the Free plan. This repository includes an alternate Worker entry point at `cloudflare/worker.js` and `wrangler.toml`. The hosted Worker sends Telegram alerts and Gmail messages through the Google Apps Script relay; the Python version also supports optional SMTP email for local use.

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

4. Create a Telegram bot with @BotFather, start a chat with it, and obtain your private chat ID. Configure the Telegram secrets below. The Gmail relay secrets are described in the Gmail section above.

   ```powershell
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   Enter the value when Wrangler prompts. Never commit either value.

5. Keep `AVAILABILITY_MODE = "disabled"` until you have verified a documented/permitted JSON stock source. Then edit `AVAILABILITY_MODE`, `AVAILABILITY_URL`, `AVAILABILITY_STATUS_PATH`, and the explicit stock-value lists in `wrangler.toml`.
6. Deploy:

   ```powershell
   npx wrangler deploy
   ```

7. Open Cloudflare Dashboard → Workers & Pages → your Worker → Settings/Triggers and confirm the Cron Trigger is `*/3 * * * *`. Check **Logs** after scheduled runs.

The Worker reads and saves state in a KV namespace. At a 3-minute schedule it may save about 480 times per day, before manual checks, which is below the documented free-tier write allowance of 1,000 writes/day. KV is eventually consistent, so a short delay or rare duplicate is possible. Source-side rate limits still take priority over checking every three minutes.

**Do not set an endpoint URL until you have verified that automated polling is permitted.** The Worker performs unauthenticated GET requests only and never uses Microsoft account cookies, sessions, passwords, or CAPTCHA bypasses. It treats unclear responses as `UNKNOWN` and will not send an availability alert.

## Security

Never commit `.env`, bot tokens, email app passwords, Microsoft account credentials, browser cookies, or session tokens. The tool only sends notifications; it never redeems points.
