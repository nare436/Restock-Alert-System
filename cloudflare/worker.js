import { DurableObject } from "cloudflare:workers";

const REDEMPTION_FALLBACK = "https://rewards.bing.com/redeem/sku/000885000034";
const STATE_KEY = "restock-state";
const REMINDER_INTERVAL_MS = 30_000;
const CHECK_INTERVAL_MS = 180_000;
const TIMEOUT_MS = 10_000;

function parseList(value, fallback) {
  return (value || fallback).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}
function readPath(document, dottedPath) {
  if (!dottedPath) throw new Error("AVAILABILITY_STATUS_PATH is missing");
  let value = document;
  for (const part of dottedPath.split(".")) {
    if (value === null || typeof value !== "object" || !(part in value)) throw new Error("Configured status field missing");
    value = value[part];
  }
  return value;
}
function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : null;
}
function initialState() {
  return {
    status: null, lastCheckStatus: "UNKNOWN", lastCheckedAt: null,
    lastDetail: "No check has run yet.", initialAlertSent: false,
    remindersEnabled: true, cooldownUntil: null,
  };
}
function redemptionUrl(env) {
  return env.REDEMPTION_URL || REDEMPTION_FALLBACK;
}
function indianDate(value) {
  if (!value) return "not yet";
  return new Date(value).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium",
  }) + " IST";
}
function stockAlertText(env) {
  return "🎉 Microsoft Rewards Flipkart gift-card alert!\n\n" +
    "The latest permitted check indicates the card may be available. Open the page and verify immediately; stock can change.\n\n" +
    redemptionUrl(env) +
    "\n\nI'll send reminders every 30 seconds until you use /stop or a later check no longer confirms availability.";
}
function reminderText(env, state) {
  return "⏰ Flipkart gift-card reminder\n\n" +
    "The latest scheduled check reported IN STOCK at " + indianDate(state.lastCheckedAt) +
    ". This reminder uses that last confirmed result; stock can change between checks.\n\n" +
    redemptionUrl(env) + "\n\nUse /stop to pause reminders, /check to check now, or /status for the latest result.";
}
function resultText(env, result, state) {
  const icon = result.status === "IN_STOCK" ? "✅" : result.status === "OUT_OF_STOCK" ? "⏳" : "⚠️";
  return icon + " Gift-card status: " + result.status.replaceAll("_", " ") + "\n\n" +
    result.detail + "\nChecked: " + indianDate(state.lastCheckedAt) +
    "\n30-second reminders: " + (state.remindersEnabled ? "ON" : "OFF") + "\n\n" + redemptionUrl(env);
}
function statusText(env, state) {
  return "📊 Restock monitor status\n\n" +
    "Latest result: " + (state.lastCheckStatus || "UNKNOWN").replaceAll("_", " ") + "\n" +
    "Last checked: " + indianDate(state.lastCheckedAt) + "\n" +
    "Details: " + (state.lastDetail || "No details available.") + "\n" +
    "Reminders: " + (state.remindersEnabled ? "ON (every 30 seconds while last confirmed in stock)" : "OFF") +
    "\n\n" + redemptionUrl(env);
}
function helpText() {
  return "🤖 Microsoft Rewards Restock Alert\n\n" +
    "/check — check availability now\n/status — show latest result\n" +
    "/stop — stop 30-second reminders\n/resume — resume reminders\n" +
    "/test — send a test Telegram message\n/help — show commands\n\n" +
    "Automatic stock checks run every 3 minutes. If a permitted source confirms IN STOCK, reminders repeat every 30 seconds. The source must be configured before real stock results are available.";
}

export class RestockCoordinator extends DurableObject {
  async getState() {
    return (await this.ctx.storage.get(STATE_KEY)) || initialState();
  }
  async saveState(state) {
    await this.ctx.storage.put(STATE_KEY, state);
  }
  async sendTelegram(chatId, text) {
    if (!this.env.TELEGRAM_BOT_TOKEN || !chatId) {
      console.error("Telegram token or chat ID is missing.");
      return false;
    }
    try {
      const response = await fetch(
        "https://api.telegram.org/bot" + this.env.TELEGRAM_BOT_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: String(chatId), text }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        console.error("Telegram send returned HTTP " + response.status + ".");
        return false;
      }
      return (await response.json()).ok === true;
    } catch (_error) {
      console.error("Telegram message failed.");
      return false;
    }
  }
  async readAvailability() {
    const env = this.env;
    if (env.AVAILABILITY_MODE !== "json_api") {
      return { status: "UNKNOWN", detail: "No verified/permitted availability source is configured yet." };
    }
    if (!env.AVAILABILITY_URL || !env.AVAILABILITY_STATUS_PATH) {
      return { status: "UNKNOWN", detail: "Availability URL/status field is missing." };
    }
    let response;
    try {
      response = await fetch(env.AVAILABILITY_URL, {
        method: "GET", headers: { Accept: "application/json", "User-Agent": "PersonalRestockAlert/1.0" },
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow",
      });
    } catch (_error) {
      return { status: "UNKNOWN", detail: "Availability request failed." };
    }
    if (response.status === 429) return {
      status: "UNKNOWN", detail: "The source is rate-limiting checks.",
      retryAfter: retryAfterMs(response.headers.get("Retry-After")),
    };
    if (response.status !== 200) return { status: "UNKNOWN", detail: "Unexpected HTTP status " + response.status + "." };
    if (!(response.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
      return { status: "UNKNOWN", detail: "The source did not return JSON." };
    }
    try {
      const payload = await response.json();
      const value = String(readPath(payload, env.AVAILABILITY_STATUS_PATH)).trim().toLowerCase();
      if (parseList(env.IN_STOCK_VALUES, "available,in_stock,true,1").includes(value)) {
        return { status: "IN_STOCK", detail: "Configured field explicitly indicates availability." };
      }
      if (parseList(env.OUT_OF_STOCK_VALUES, "unavailable,out_of_stock,false,0").includes(value)) {
        return { status: "OUT_OF_STOCK", detail: "Configured field explicitly indicates no stock." };
      }
      return { status: "UNKNOWN", detail: "Unrecognized availability value." };
    } catch (_error) {
      return { status: "UNKNOWN", detail: "Could not read the configured status field." };
    }
  }
  async runAvailabilityCheck(manualChatId = null) {
    const state = await this.getState();
    const now = Date.now();
    if (state.cooldownUntil && now < state.cooldownUntil) {
      const result = { status: "UNKNOWN", detail: "Source asked us to wait about " + Math.ceil((state.cooldownUntil - now) / 1000) + " more seconds." };
      state.lastCheckStatus = result.status;
      state.lastCheckedAt = new Date(now).toISOString();
      state.lastDetail = result.detail;
      await this.saveState(state);
      if (manualChatId) await this.sendTelegram(manualChatId, resultText(this.env, result, state));
      return result;
    }
    state.cooldownUntil = null;
    const result = await this.readAvailability();
    state.lastCheckStatus = result.status;
    state.lastCheckedAt = new Date().toISOString();
    state.lastDetail = result.detail;
    if (result.status === "UNKNOWN") {
      state.status = "UNKNOWN";
      state.initialAlertSent = false;
      if (result.retryAfter !== undefined && result.retryAfter !== null) {
        state.cooldownUntil = Date.now() + Math.max(CHECK_INTERVAL_MS, result.retryAfter);
      }
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      if (manualChatId) await this.sendTelegram(manualChatId, resultText(this.env, result, state));
      return result;
    }
    if (result.status === "OUT_OF_STOCK") {
      state.status = "OUT_OF_STOCK";
      state.initialAlertSent = false;
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      if (manualChatId) await this.sendTelegram(manualChatId, resultText(this.env, result, state));
      return result;
    }

    if (state.status !== "IN_STOCK") state.initialAlertSent = false;
    state.status = "IN_STOCK";
    if (state.remindersEnabled) {
      if (!state.initialAlertSent) {
        const message = manualChatId ? resultText(this.env, result, state) : stockAlertText(this.env);
        const delivered = await this.sendTelegram(manualChatId || this.env.TELEGRAM_CHAT_ID, message);
        if (delivered) state.initialAlertSent = true;
      } else if (manualChatId) {
        await this.sendTelegram(manualChatId, resultText(this.env, result, state));
      }
      await this.ctx.storage.setAlarm(Date.now() + REMINDER_INTERVAL_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
      if (manualChatId) await this.sendTelegram(manualChatId, resultText(this.env, result, state));
    }
    await this.saveState(state);
    return result;
  }
  async alarm() {
    const state = await this.getState();
    if (state.status !== "IN_STOCK" || !state.remindersEnabled) return;
    if (!state.initialAlertSent) {
      const sent = await this.sendTelegram(this.env.TELEGRAM_CHAT_ID, stockAlertText(this.env));
      if (sent) state.initialAlertSent = true;
    } else {
      await this.sendTelegram(this.env.TELEGRAM_CHAT_ID, reminderText(this.env, state));
    }
    await this.saveState(state);
    if (state.status === "IN_STOCK" && state.remindersEnabled) {
      await this.ctx.storage.setAlarm(Date.now() + REMINDER_INTERVAL_MS);
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/scheduled-check") {
      await this.runAvailabilityCheck();
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/command") return new Response("Not found", { status: 404 });
    let body;
    try { body = await request.json(); } catch (_error) { return new Response("Bad request", { status: 400 }); }
    const command = body.command;
    const chatId = String(body.chatId || "");
    if (!chatId) return new Response("Missing chat ID", { status: 400 });
    if (command === "/start" || command === "/help") {
      await this.sendTelegram(chatId, helpText());
    } else if (command === "/check") {
      await this.runAvailabilityCheck(chatId);
    } else if (command === "/status") {
      await this.sendTelegram(chatId, statusText(this.env, await this.getState()));
    } else if (command === "/stop") {
      const state = await this.getState();
      state.remindersEnabled = false;
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      await this.sendTelegram(chatId, "🔕 30-second reminders are OFF. Automatic stock checks still run every 3 minutes. Send /resume to turn reminders back on.");
    } else if (command === "/resume") {
      const state = await this.getState();
      state.remindersEnabled = true;
      await this.saveState(state);
      if (state.status === "IN_STOCK") {
        await this.ctx.storage.setAlarm(Date.now() + REMINDER_INTERVAL_MS);
        await this.sendTelegram(chatId, "🔔 Reminders are ON. Your last check reported IN STOCK at " + indianDate(state.lastCheckedAt) + ". The next reminder is due in about 30 seconds. Use /check to refresh now.");
      } else {
        await this.sendTelegram(chatId, "🔔 Reminders are ON. Automatic checks run every 3 minutes. I'll start reminders if a permitted source confirms the gift card is in stock.");
      }
    } else if (command === "/test") {
      await this.sendTelegram(chatId, "✅ Test notification received. Your Telegram bot can send messages. This is not a stock alert.\n\n" + redemptionUrl(this.env));
    } else {
      await this.sendTelegram(chatId, "I don't recognize that command. Send /help to see available commands.");
    }
    return Response.json({ ok: true });
  }
}

export default {
  async scheduled(_controller, env) {
    const id = env.RESTOCK_COORDINATOR.idFromName("main");
    await env.RESTOCK_COORDINATOR.get(id).fetch("https://coordinator/scheduled-check", { method: "POST" });
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (!env.TELEGRAM_WEBHOOK_SECRET ||
          request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch (_error) { return new Response("Bad request", { status: 400 }); }
      const message = update.message;
      if (!message || !message.chat || typeof message.text !== "string") return new Response("OK");
      const chatId = String(message.chat.id);
      if (!env.TELEGRAM_CHAT_ID || chatId !== String(env.TELEGRAM_CHAT_ID)) {
        console.warn("Ignored message from an unapproved chat.");
        return new Response("OK");
      }
      const command = message.text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
      const id = env.RESTOCK_COORDINATOR.idFromName("main");
      await env.RESTOCK_COORDINATOR.get(id).fetch("https://coordinator/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, chatId }),
      });
      return new Response("OK");
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        "Restock Alert Worker is running. Stock checks: every 3 minutes. Reminders: every 30 seconds while last confirmed in stock. Telegram commands: /check, /status, /stop, /resume, /test, /help.\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
