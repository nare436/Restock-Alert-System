/**
 * Gmail email relay for the Restock Alert System.
 *
 * Deploy this as a Google Apps Script web app that executes as you.
 * Store these values under Project Settings -> Script properties:
 *   EMAIL_TO = your own recipient email address
 *   EMAIL_RELAY_SECRET = a long random secret shared with Cloudflare as a secret
 *
 * Only two fixed email types are accepted. The recipient is never taken from
 * the request, so this endpoint cannot be instructed to email arbitrary people.
 */

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService
    .createTextOutput("Restock Alert Gmail relay is deployed.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const expectedSecret = props.getProperty("EMAIL_RELAY_SECRET");
  const recipient = props.getProperty("EMAIL_TO");
  const redemptionUrl =
    props.getProperty("REDEMPTION_URL") ||
    "https://rewards.bing.com/redeem/sku/000885000034";

  if (!expectedSecret || !recipient) {
    return jsonResponse({ ok: false, error: "Relay is not configured." });
  }

  let request;
  try {
    request = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (_error) {
    return jsonResponse({ ok: false, error: "Invalid JSON." });
  }

  if (
    typeof request.secret !== "string" ||
    request.secret.length < 20 ||
    request.secret !== expectedSecret
  ) {
    return jsonResponse({ ok: false, error: "Unauthorized." });
  }

  const kind = request.kind;
  let subject;
  let body;

  if (kind === "test") {
    subject = "Restock Alert System — test email";
    body =
      "This is a test email from your Microsoft Rewards Flipkart Restock Alert System.\n\n" +
      "If you received this, the Gmail notification relay is working. This is not a stock alert.\n\n" +
      redemptionUrl;
  } else if (kind === "restock") {
    subject = "Microsoft Rewards — Flipkart gift-card restock alert";
    body =
      "The Flipkart gift card may be available in Microsoft Rewards.\n\n" +
      "Please open the official page and verify availability before redeeming. " +
      "This message is not a guarantee of live stock.\n\n" +
      redemptionUrl;
  } else {
    return jsonResponse({ ok: false, error: "Unsupported email type." });
  }

  try {
    MailApp.sendEmail(recipient, subject, body);
    return jsonResponse({ ok: true });
  } catch (_error) {
    console.error("MailApp.sendEmail failed.");
    return jsonResponse({ ok: false, error: "Email service failed." });
  }
}

/**
 * Run this function manually in the Apps Script editor once to trigger Gmail
 * permission consent before deploying the web app. It sends no email.
 */
function authorizeMailPermissions() {
  const remaining = MailApp.getRemainingDailyQuota();
  console.log("Mail relay ready. Remaining recipient quota: " + remaining);
}
