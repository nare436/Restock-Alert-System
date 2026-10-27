/**
 * Cloudflare Worker for a Microsoft Rewards gift-card restock notifier.
 *
 * This tool does not redeem rewards. The stock checker stays UNKNOWN until a
 * documented/permitted availability source is configured.
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
    notifiedTelegram: false,
    notifiedEmail: false,
    lastCheckStatus: null,
    lastCheckedAt: null,
    lastDetail: "No check has run yet.",
    cooldownUntil: null,
  };
}

function migrateState(state) {
  const initial = baseState();
  if (!state || typeof state !== "object") return initial;
  return {
    ...initial,
    ...state,
    // Old versions used a single "notified" flag for Telegram.
    notifiedTelegram: state.notifiedTelegram ?? state.notified ?? false,
    notifiedEmail: state.notifiedEmail ?? false,
  };
}

function redemptionUrl(env) {
  return env.REDEMPTION_URL || REDEMPTION_FALLBACK;
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
    const state = await env.ALERT_STATE.get(STATE_KEY, "json");
    return migrateState(state);
  } catch (_error) {
    console.error("Could not read saved state.");
    return null;
  }
}

async function saveState(env, state) {
  await env.ALERT_STATE.put(STATE_KEY, JSON.stringify(state));
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

async function sendEmailRelay(env, kind) {
  if (!env.EMAIL_RELAY_URL || !env.EMAIL_RELAY_SECRET) {
    console.error("Gmail relay is not configured.");
    return false;
  }
  if (!["restock", "test"].includes(kind)) return false;

  try {
    const response = await fetch(env.EMAIL_RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.EMAIL_RELAY_SECRET,
        kind,
        redemptionUrl: redemptionUrl(env),
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!response.ok) {
      console.error(`Gmail relay returned HTTP ${response.status}.`);
      return false;
    }
    const result = await response.json();
    if (result.ok !== true) {
      console.error("Gmail relay did not confirm email delivery.");
      return false;
    }
    return true;
  } catch (_error) {
    console.error("Gmail relay request failed.");
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

async function notifyRestockChannels(env, state) {
  if (!state.notifiedTelegram) {
    const ok = await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, restockAlertText(env));
    if (ok) state.notifiedTelegram = true;
  }
  if (!state.notifiedEmail) {
    const ok = await sendEmailRelay(env, "restock");
    if (ok) state.notifiedEmail = true;
  }
  return state;
}

async function checkAndNotify(env, manualChatId = null) {
  const state = await readState(env);
  if (!state) {
    if (manualChatId) {
      await sendTelegramMessage(
        env,
        manualChatId,
        "⚠️ I could not read the saved monitoring state. Please check Worker logs.",
      );
    }
    return { status: "UNKNOWN", detail: "Saved state unavailable." };
  }

  const now = Date.now();
  const cooldownAt =
    typeof state.cooldownUntil === "number"
      ? state.cooldownUntil
      : (state.cooldownUntil ? Date.parse(state.cooldownUntil) : NaN);

  if (Number.isFinite(cooldownAt) && now < cooldownAt) {
    const waitSeconds = Math.ceil((cooldownAt - now) / 1000);
    const result = {
      status: "UNKNOWN",
      detail: `The source asked us to wait. Try again in about ${waitSeconds} seconds.`,
    };
    state.lastCheckStatus = result.status;
    state.lastCheckedAt = new Date(now).toISOString();
    state.lastDetail = result.detail;
    await saveState(env, state);
    if (manualChatId) await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
    return result;
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
    if (manualChatId) await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
    console.log(`Availability status: UNKNOWN; ${result.detail}`);
    return result;
  }

  if (result.status === "OUT_OF_STOCK") {
    state.status = "OUT_OF_STOCK";
    state.notifiedTelegram = false;
    state.notifiedEmail = false;
    await saveState(env, state);
    if (manualChatId) await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
    console.log("Availability status: OUT_OF_STOCK");
    return result;
  }

  // Alert each configured channel independently. Failed channels retry later,
  // without repeating delivery to channels that already succeeded.
  state.status = "IN_STOCK";
  await notifyRestockChannels(env, state);
  await saveState(env, state);

  if (manualChatId) {
    await sendTelegramMessage(env, manualChatId, checkResultText(env, result));
  }
  console.log("Availability status: IN_STOCK");
  return result;
}

function helpText() {
  return (
    "🤖 Microsoft Rewards Restock Alert Bot\n\n" +
    "/check — check availability now\n" +
    "/status — show the last saved check result\n" +
    "/testemail — send a test email to your configured Gmail address\n" +
    "/help — show these commands\n\n" +
    "Automatic checks run every 3 minutes. A manual /check is on demand but respects source rate limits. " +
    "The stock checker works only after a permitted availability source is configured."
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
    const latest = await readState(env);
    await sendTelegramMessage(
      env,
      chatId,
      latest ? statusReply(env, latest) : "⚠️ Could not read saved status. Check Worker logs.",
    );
    return new Response("OK");
  }
  if (command === "/check") {
    await checkAndNotify(env, chatId);
    return new Response("OK");
  }
  if (command === "/testemail") {
    const ok = await sendEmailRelay(env, "test");
    await sendTelegramMessage(
      env,
      chatId,
      ok
        ? "✅ Test email sent to your configured Gmail address."
        : "❌ Test email failed. Check your Google Apps Script deployment and Cloudflare email relay secrets.",
    );
    return new Response("OK");
  }

  await sendTelegramMessage(env, chatId, "I don't recognize that command. Send /help to see available commands.");
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
        "Restock Alert Worker is running. Automatic checks run every 3 minutes. In Telegram, use /check, /status, /testemail, or /help.\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
