# Microsoft Rewards Flipkart Restock Alert — Telegram only

A Telegram-only monitor for the Microsoft Rewards Flipkart gift card. Automatic stock checks run every **3 minutes**. When a documented/permitted source confirms availability, Telegram sends an initial alert followed by reminders every **30 seconds** until you use `/stop` or a later scheduled check no longer confirms availability.

The system does not redeem points or make purchases, and it does not need your Microsoft password.

Gift-card page: https://rewards.bing.com/redeem/sku/000885000034

## Important: the stock source is not configured yet

This repository does not currently have a verified, permitted Microsoft Rewards stock API configured. The default result is `UNKNOWN`. Telegram setup can be completed and tested, but genuine stock notifications will not work until a documented/permitted source that explicitly indicates availability is identified. Do not use guessed endpoints or private account cookies.

## Telegram commands

- `/check` — run an availability check now, subject to source rate limits.
- `/status` — show the latest result, check time, and reminder setting.
- `/stop` — stop 30-second reminders; the scheduled 3-minute checks continue.
- `/resume` — turn reminders back on.
- `/test` — send a test Telegram message.
- `/help` — show commands.

A 30-second reminder repeats the **last confirmed IN STOCK result**; it does not call the stock source every 30 seconds. The next stock check is scheduled within about 3 minutes and cancels reminders if it reports `OUT_OF_STOCK` or `UNKNOWN`. Therefore, a reminder can refer to a result up to three minutes old.

## Beginner setup (Windows)

You need your Telegram bot token from @BotFather, the chat ID of your private conversation with the bot, and a free Cloudflare account. **Never share the bot token or webhook secret in GitHub or this chat.**

### Step 1 — Get your Telegram chat ID

1. In Telegram, open your bot and press **Start**. Send it `/start`.
2. Install Node.js LTS from https://nodejs.org/ if you do not already have it.
3. Download this repository from https://github.com/nare436/Restock-Alert-System/archive/refs/heads/main.zip and extract it. Open the extracted folder, click the File Explorer address bar, type `powershell`, and press Enter.
4. In PowerShell, run these commands. When asked, paste your bot token **into PowerShell only**:

   ```powershell
   $botToken = Read-Host "Paste your Telegram bot token"
   $updates = Invoke-RestMethod -Uri ("https://api.telegram.org/bot{0}/getUpdates" -f $botToken)
   $updates.result | ForEach-Object { if ($_.message.chat.id) { "Chat ID: " + $_.message.chat.id } }
   ```

5. Copy the numeric chat ID. Keep the PowerShell window open. If no ID appears, send your bot another message and run the two commands again. Get the ID before registering a webhook.

### Step 2 — Sign in to Cloudflare and deploy

1. Create/sign in to Cloudflare at https://dash.cloudflare.com/.
2. In PowerShell, with the current directory set to the extracted repository folder, run:

   ```powershell
   npx wrangler login
   ```

   A browser will open; approve the connection.

3. Deploy:

   ```powershell
   npx wrangler deploy
   ```

   The first deploy creates the Worker and its SQLite-backed Durable Object used for 30-second reminders. The command prints a Worker URL, normally shaped like `https://restock-alert-system.<your-account>.workers.dev`. Keep that URL for Step 4.

### Step 3 — Add three Telegram secrets privately

Run each command in PowerShell. Wrangler will prompt for a value; enter it there rather than adding it to a file.

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

- `TELEGRAM_BOT_TOKEN`: the token from @BotFather.
- `TELEGRAM_CHAT_ID`: the numeric chat ID from Step 1.
- `TELEGRAM_WEBHOOK_SECRET`: generate a private random value in PowerShell with `[guid]::NewGuid().ToString("N")`. Save it temporarily, enter it when Wrangler prompts, and use that same value in Step 4. It is not your bot token.

### Step 4 — Connect Telegram to your Worker

Run the following PowerShell commands and answer the prompts. Do not paste the token into this chat.

```powershell
$botToken = Read-Host "Paste Telegram bot token"
$webhookSecret = Read-Host "Paste the same webhook secret you saved in Cloudflare"
$workerUrl = Read-Host "Paste your Worker URL from the deploy command"
$body = @{
  url = "$($workerUrl.TrimEnd('/'))/telegram"
  secret_token = $webhookSecret
  allowed_updates = @("message")
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri ("https://api.telegram.org/bot{0}/setWebhook" -f $botToken) -ContentType "application/json" -Body $body
Remove-Variable botToken, webhookSecret
```

The response should include `ok = true`.

### Step 5 — Test Telegram

Return to Telegram and send:

1. `/start` — show bot help.
2. `/test` — verify the bot can send messages.
3. `/status` — view the latest saved check.
4. `/check` — attempt a manual availability check.

If the source is not configured, `/check` reports `UNKNOWN`. That is expected; it avoids giving you a false stock alert.

## Free-tier behavior

- Cloudflare Cron Trigger checks availability every 3 minutes.
- A Durable Object alarm sends a reminder every 30 seconds while the last confirmed status is in stock.
- `/stop` disables reminders; `/resume` enables them again.
- At 30-second intervals, as many as 2,880 reminder messages per day could be sent while the item stays in stock. Use `/stop` if this is too frequent. Free-tier quotas and platform availability apply.

## Optional local Python version

The repository also contains a local Python checker for Telegram. It defaults to `UNKNOWN` until a permitted source is configured. For Windows setup:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python -m unittest discover -s tests -v
python -m src.monitor --test-notification
```

For local Telegram testing only, set `NOTIFY_TELEGRAM=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in the local `.env` file. Keep `.env` private and never commit it.

## Security

- Never share your Telegram bot token or webhook secret.
- Never put a Microsoft password, session cookie, or account token in this project.
- Commands are accepted only from the configured private chat ID and Telegram's webhook secret header must match.
- The bot only notifies you; it never redeems points automatically.
