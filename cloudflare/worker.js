/**
 * Cloudflare Worker implementation for minute-by-minute checks.
 *
 * Configure only a documented/permitted, unauthenticated JSON endpoint.
 * This script never uses Microsoft account cookies, passwords, or session tokens.
 */
const STATE_KEY = "flipkart-gift-card-state";
const MIN_COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

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

async function readAvailability(env) {
  if (env.AVAILABILITY_MODE !== "json_api") {
    return { status: "UNKNOWN", detail: "No permitted availability source configured." };
  }
  if (!env.AVAILABILITY_URL || !env.AVAILABILITY_STATUS_PATH) {
    return { status: "UNKNOWN", detail: "Availability URL/status path is missing." };
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
  } catch (error) {
    return { status: "UNKNOWN", detail: "Availability request failed." };
  }

  if (response.status === 429) {
    return {
      status: "UNKNOWN",
      detail: "Source rate-limited the request.",
      retryAfter: retryAfterMs(response.headers.get("Retry-After")),
    };
  }
  if (response.status !== 200) {
    return { status: "UNKNOWN", detail: `Unexpected HTTP status ${response.status}.` };
  }
  if (!(response.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
    return { status: "UNKNOWN", detail: "Source did not return JSON." };
  }

  try {
    const payload = await response.json();
    const value = String(readPath(payload, env.AVAILABILITY_STATUS_PATH)).trim().toLowerCase();
    const inStock = parseList(env.IN_STOCK_VALUES, "available,in_stock,true,1");
    const outOfStock = parseList(env.OUT_OF_STOCK_VALUES, "unavailable,out_of_stock,false,0");

    if (inStock.includes(value)) {
      return { status: "IN_STOCK", detail: "Explicit configured availability value." };
    }
    if (outOfStock.includes(value)) {
      return { status: "OUT_OF_STOCK", detail: "Explicit configured unavailable value." };
    }
    return { status: "UNKNOWN", detail: "Unrecognized status value." };
  } catch (error) {
    return { status: "UNKNOWN", detail: "Could not parse configured JSON status field." };
  }
}

async function readState(env) {
  try {
    return (await env.ALERT_STATE.get(STATE_KEY, "json", { cacheTtl: 60 })) || {
      status: null,
      notified: false,
    };
  } catch (error) {
    console.error("Could not read KV state; no alert will be sent this run.");
    return null;
  }
}

async function saveState(env, state) {
  await env.ALERT_STATE.put(STATE_KEY, JSON.stringify(state));
}

async function sendTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram configuration; set the token and chat ID secrets.");
    return false;
  }

  const message =
    "🎉 Microsoft Rewards restock alert\n\n" +
    "The Flipkart gift card may be available. Verify on the official page and redeem manually. " +
    "This alert does not guarantee live stock.\n\n" +
    (env.REDEMPTION_URL || "https://rewards.bing.com/redeem/sku/000885000034");

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error(`Telegram returned HTTP ${response.status}.`);
      return false;
    }
    const payload = await response.json();
    return payload.ok === true;
  } catch (error) {
    console.error("Telegram notification request failed.");
    return false;
  }
}

async function checkAndNotify(env) {
  if (!env.ALERT_STATE) {
    console.error("Bind a KV namespace named ALERT_STATE before deploying.");
    return;
  }

  const state = await readState(env);
  if (!state) return;

  const now = Date.now();
  if (state.cooldownUntil && now < state.cooldownUntil) {
    console.log("Skipping this run because Retry-After cooldown is active.");
    return;
  }
  if (state.cooldownUntil) delete state.cooldownUntil;

  const result = await readAvailability(env);
  console.log(`Availability status: ${result.status}; ${result.detail}`);

  if (result.status === "UNKNOWN") {
    if (result.retryAfter !== undefined && result.retryAfter !== null) {
      // Be more conservative than short Retry-After values to avoid hammering a
      // source and keep KV writes below the free-tier daily quota.
      state.cooldownUntil = now + Math.max(MIN_COOLDOWN_MS, result.retryAfter);
      await saveState(env, state);
    } else if (state.cooldownUntil) {
      await saveState(env, state);
    }
    return;
  }

  if (result.status === "OUT_OF_STOCK") {
    if (state.status !== "OUT_OF_STOCK" || state.notified || state.cooldownUntil) {
      await saveState(env, { status: "OUT_OF_STOCK", notified: false });
    }
    return;
  }

  // Notify on first known in-stock state, or retry if a prior alert failed.
  if (state.status !== "IN_STOCK" || state.notified !== true) {
    const delivered = await sendTelegram(env);
    if (delivered) {
      await saveState(env, { status: "IN_STOCK", notified: true });
      console.log("Telegram notification sent.");
    } else {
      // Do not mark successful delivery; the next scheduled check can retry.
      await saveState(env, { status: state.status, notified: false });
    }
  }
}

export default {
  async scheduled(_controller, env, _ctx) {
    await checkAndNotify(env);
  },

  // A manual health endpoint; it reports configuration only and never checks
  // the target API on an HTTP request.
  async fetch() {
    return new Response(
      "Restock Alert Worker is running. Stock checks happen on the configured Cron Trigger.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};
