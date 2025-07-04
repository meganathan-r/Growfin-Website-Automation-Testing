import puppeteer from "puppeteer";
import fs from "fs";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { WebClient } from "@slack/web-api";

const DIR_SCREENSHOTS = "screens";
const TARGET_PAGE = "https://www.growfin.ai/book-a-demo";
const IFRAME_SELECTOR = "#hubSpotFormHere iframe.hs-form-iframe";
const REQUIRED_FIELDS = [
  { name: "email", sel: 'input[name="email"]' },
  { name: "choose_your_erp", sel: 'select[name="choose_your_erp"]' },
  { name: "message", sel: 'textarea[name="message"]' },
];
const UPLOAD_SCREENSHOT_ON_SUCCESS = false;

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const channel = process.env.SLACK_CHANNEL_ID;

// Ensure screenshots dir exists (absolute-path-safe)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(__dirname, DIR_SCREENSHOTS);
if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir);

function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
async function sendSlack(text, filePath = null) {
  await slack.chat.postMessage({ channel, text });

  if (filePath && fs.existsSync(filePath)) {
    await slack.files.uploadV2({
      channel_id: channel, // NOTE: singular, not “channels”
      file: fs.createReadStream(filePath),
      filename: path.basename(filePath),
      title: "Growfin audit screenshot",
      initial_comment: "Screenshot attached.",
    });
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Path for today’s screenshot
  const shotPath = path.join(shotsDir, `book-demo-${Date.now()}.png`);

  let checkOK = false;
  let detail = "";

  try {
    /* 1️⃣  Load page */
    await page.goto(TARGET_PAGE, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    /* 2️⃣  Access HubSpot iframe */
    await page.waitForSelector(IFRAME_SELECTOR, {
      visible: true,
      timeout: 15_000,
    });
    const frameHandle = await page.$(IFRAME_SELECTOR);
    const frame = await frameHandle.contentFrame();
    if (!frame) throw new Error("Cannot access HubSpot iframe");

    /* 3️⃣  Verify required fields */
    await Promise.all(
      REQUIRED_FIELDS.map((f) =>
        frame.waitForSelector(f.sel, { visible: true, timeout: 10_000 })
      )
    );

    // Extra – double-check via evaluate
    const missing = await frame.evaluate(
      (fields) =>
        fields.filter((f) => !document.querySelector(f.sel)).map((f) => f.name),
      REQUIRED_FIELDS
    );
    if (missing.length)
      throw new Error(`Missing form inputs: ${missing.join(", ")}`);

    detail = "All HubSpot fields present.";
    checkOK = true;
  } catch (err) {
    detail = err.message;
    checkOK = false;
  }

  /* 4️⃣  Screenshot */
  await page.screenshot({ path: shotPath, fullPage: true });

  /* 5️⃣  Slack report */
  const statusEmoji = checkOK ? "✅" : "❌";
  const summary =
    `${statusEmoji} Growfin Book a Demo Form Check – ${
      checkOK ? "PASS" : "FAIL"
    }\n` +
    `Time: ${nowIST()}\n` +
    `Details: ${detail}`;

  await sendSlack(
    summary,
    !checkOK && !UPLOAD_SCREENSHOT_ON_SUCCESS ? null : shotPath
  );
  await browser.close();
  process.exit(checkOK ? 0 : 1);
})();
