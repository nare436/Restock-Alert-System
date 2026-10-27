/**
 * Cloudflare Worker for a Microsoft Rewards gift-card availability notifier.
 *
 * The actual stock source must be documented/permitted and explicitly indicate
 * availability. Never add Microsoft account cookies, passwords, or sessions.
 */
const STATE_KEY = "flipkart-gift-card-state";
const MIN_COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const REDEMPTION_FALLBACK = "https://rewards.bing.com/redeem/sku/000885000034";

function parseList(value, fallback) {
  return (value || fallback)
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function readPath(document, dottedPath) {
  if (!dottedPath) throw new Error("AVAILABILITY_STATUS_PATH is missing");
  let value = document;
  for (const part of dottedPath.split(".")) {
    if (value === null || typeof value !== "object" || !(part in value)) {
      throw new Error("Configured JSON status field was not found");
    }
    value = value[part];
  }
  return value;
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function baseState() {
  return {
    status: null,
    notified: false,
    lastCheckStatus: null,
    lastCheckedAt: null,
    lastDetail: "No check has run yet.",
    cooldownUntil: null,
  };
}

async function readAvailability(env) {
  if (env.AVAILABILITY_MODE !== "json_api") {
    return { status: "UNKNOWN", detail: "Availability source is not configured yet." };
  }
  if (!env.AVAILABILITY_URL || !env.AVAILABILITY_STATUS_PATH) {
    return { status: "UNKNOWN", detail: "Availability URL/status field is missing." };
  }

  let response;
  try {
    response = await fetch(env.AVAILABILITY_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "PersonalRestockAlert/1.0 (availability monitor)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (_error) {
    return { status: "UNKNOWN", detail: "The availability request failed." };
  }

  if (response.status === 429) {
    return {
      status: "UNKNOWN",
      detail: "The data source is rate-limiting checks.",
      retryAfter: retryAfterMs(response.headers.get("Retry-After")),
    };
  }
  if (response.status !== 200) {
    return { status: "UNKNOWN", detail: `Unexpected HTTP status ${response.status}.` };
  }
  if (!(response.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
    return { status: "UNKNOWN", detail: "The source did not return JSON." };
  }

  try {
    const payload = await response.json();
    const value = String(readPath(payload, env.AVAILABILITY_STATUS_PATH)).trim().toLowerCase();
    const inStock = parseList(env.IN_STOCK_VALUES, "available,in_stock,true,1");
    const outOfStock = parseList(env.OUT_OF_STOCK_VALUES, "unavailable,out_of_stock,false,0");

    if (inStock.includes(value)) {
      return { status: "IN_STOCK", detail: "The configured status field indicates availability." };
    }
    if (outOfStock.includes(value)) {
      return { status: "OUT_OF_STOCK", detail: "The configured status field indicates no stock." };
    }
    return { status: "UNKNOWN", detail: "The status value was not recognized." };
  } catch (_error) {
    return { status: "UNKNOWN", detail: "Could not read the configured status field." };
  }
}

async function readState(env) {
  if (!env.ALERT_STATE) {
    console.error("Bind a KV namespace named ALERT_STATE.");
    return null;
  }
  try {
    return (await env.ALERT_STATE.get(STATE_KEY, "json")) || baseState();
  } catch (_error) {
    console.error("Could not read saved state.");
    return null;
  }
}

async function saveState(env, state) {
  await env.ALERT_STATE.put(STATE_KEY, JSON.stringify(state));
}

function redemptionUrl(env) {
  return env.REDEMPTION_URL || REDEMPTION_FALLBACK;
}

async function sendTelegramMessage(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    console.error("Telegram token or chat ID is missing.");
    return false;
  }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: String(chatId), text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error(`Telegram returned HTTP ${response.status}.`);
      return false;
    }
    const body = await response.json();
    return body.ok === true;
  } catch (_error) {
    console.error("Telegram notification request failed.");
    return false;
  }
}

function restockAlertText(env) {
  return (
    "🎉 Microsoft Rewards restock alert\n\n" +
    "The Flipkart gift card may be available. Open the redemption page and verify stock. " +
    "This message is not a guarantee of live availability.\n\n" +
    redemptionUrl(env)
  );
}

function checkResultText(env, result) {
  const icon = result.status === "IN_STOCK" ? "✅" : result.status === "OUT_OF_STOCK" ? "⏳" : "⚠️";
  const label = result.status.replaceAll("_", " ");
  return (
    `${icon} Manual availability check: ${label}\n\n` +
    `${result.detail}\n\n` +
    `Redemption page: ${redemptionUrl(env)}\n\n` +
    "If the source is not configured or the result is unclear, open the page to verify manually."
  );
}

function formatDate(value) {
  if (!value) return "No check has run yet.";
  try {
    return new Date(value).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "medium",
    }) + " (India time)";
  } catch (_error) {
    return value;
  }
}

function statusReply(env, state) {
  const status = state.lastCheckStatus || "UNKNOWN";
  const label = String(status).replaceAll("_", " ");
  return (
    "📊 Restock monitor status\n\n" +
    `Last check: ${label}\n` +
    `Checked at: ${formatDate(state.lastCheckedAt)}\n` +
    `Details: ${state.lastDetail || "No details available."}\n\n` +
    `Redemption page: ${redemptionUrl(env)}`
  );
}

async function checkAndNotify(env, manualChatId = null) {
  const state = await readState(env);
  if (!state) {
    if (manualChatId) {
      await sendTelegramMessage(
        env,
        manualChatId,
        "⚠️ I could not read the saved monitoring state. Please contact the bot administrator.",
      );
    }
    return { status: "UNKNOWN", detail: "Saved state unavailable." };
  }

  const now = Date.now();
  if (state.cooldownUntil && now < state.cooldownUntil) {
    const waitSeconds = Math.ceil((state.cooldownUntil - now) / 1000);
    const cooldownResult = {
      status: "UNKNOWN",
      detail: `The source asked us to wait. Try again in about ${waitSeconds} seconds.`,
    };
    state.lastCheckStatus = cooldownResult.status;
    state.lastCheckedAt = new Date(now).toISOString();
    state.lastDetail = cooldownResult.detail;
    await saveState(env, state);
    if (manualChatId) {
      await sendTelegramMessage(env, manualChatId, checkResultText(env, cooldownResult));
    }
    return cooldownResult;
  }
  state.cooldownUntil = null;

  const result = await readAvailability(env);
  state.lastCheckStatus = result.status;
  state.lastCheckedAt = new Date().toISOString();
  state.lastDetail = result.detail;

  if (result.status === "UNKNOWN") {
    if (result.retryAfter !== undefined && result.retryAfter !== null) {
      state.cooldownUntil = new Date(Date.now() + Math.max(MIN_COOLDOWN_MS, result.retryAfter)).toISOString();
    }
    await saveState(env, state);
    if (manualChatId) {
      await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
    }
    console.log(`Availability status: UNKNOWN; ${result.detail}`);
    return result;
  }

  if (result.status === "OUT_OF_STOCK") {
    state.status = "OUT_OF_STOCK";
    state.notified = false;
    await saveState(env, state);
    if (manualChatId) {
      await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
    }
    console.log("Availability status: OUT_OF_STOCK");
    return result;
  }

  // A manual /check reply itself counts as the alert for this authorized chat.
  if (manualChatId) {
    const delivered = await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
    if (delivered) {
      state.status = "IN_STOCK";
      state.notified = true;
    } else if (state.status !== "IN_STOCK") {
      state.status = "IN_STOCK";
      state.notified = false;
    }
    await saveState(env, state);
    console.log("Availability status: IN_STOCK (manual check)");
    return result;
  }

  // Scheduled checks send one restock alert until the item is seen out of stock again.
  if (state.status !== "IN_STOCK" || state.notified !== true) {
    const delivered = await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, restockAlertText(env));
    state.status = "IN_STOCK";
    state.notified = delivered;
  }
  await saveState(env, state);
  console.log("Availability status: IN_STOCK");
  return result;
}

function helpText() {
  return (
    "🤖 Microsoft Rewards Restock Alert Bot\n\n" +
    "/check — check availability now\n" +
    "/status — show the last saved check result\n" +
    "/help — show these commands\n\n" +
    "Automatic checks run every 3 minutes. A manual /check respects source rate limits. " +
    "The stock checker only works after a permitted availability source is configured."
  );
}

async function handleTelegramUpdate(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Webhook secret is not configured.", { status: 503 });
  }
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch (_error) {
    return new Response("Bad request", { status: 400 });
  }

  const message = update.message;
  if (!message || !message.chat || typeof message.text !== "string") {
    return new Response("OK");
  }

  const chatId = String(message.chat.id);
  // Do not let other people trigger checks or read saved state.
  if (!env.TELEGRAM_CHAT_ID || chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.warn("Ignored a Telegram message from an unapproved chat.");
    return new Response("OK");
  }

  const command = message.text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(env, chatId, helpText());
    return new Response("OK");
  }
  if (command === "/status") {
    const state = await readState(env);
    await sendTelegramMessage(
      env,
      chatId,
      state ? statusReply(env, state) : "⚠️ Could not read saved status. Check Worker logs.",
    );
    return new Response("OK");
  }
  if (command === "/check") {
    await checkAndNotify(env, chatId);
    return new Response("OK");
  }

  await sendTelegramMessage(env, chatId, "I don't recognize that command. Send /help to see the available commands.");
  return new Response("OK");
}

export default {
  async scheduled(_controller, env, _ctx) {
    await checkAndNotify(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegramUpdate(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        "Restock Alert Worker is running. Automatic checks run every 3 minutes. In Telegram, use /check, /status, or /help.\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
