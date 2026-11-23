/**
 * Headless screenshots: non-member channel messages (first 15 locked).
 * Playwright + system Chrome only; does not connect to 9222/9223.
 */
import { chromium } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const base = "http://127.0.0.1:3851";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: "zh-CN",
});
await context.addInitScript(() => {
  localStorage.setItem("discord-collector.onboarding.v2", "1");
  localStorage.setItem(
    "discord-collector.membership.v1",
    JSON.stringify({ isMember: false, planId: "quarterly" }),
  );
});

const page = await context.newPage();
await page.goto(`${base}/show/messages`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".member-switch", { timeout: 20000 });
await page.waitForSelector(".channel-row", { timeout: 25000 });
// wait until lock marks have been applied to the default first 15
await page.waitForFunction(() => document.querySelectorAll('.channel-row[data-member-locked="1"]').length > 0, { timeout: 20000 });
await page.waitForTimeout(800);

const locked = await page.locator('.channel-row[data-member-locked="1"]').count();
const free = await page.locator('.channel-row:not([data-member-locked="1"])').count();
const lockedNames = await page.locator('.channel-row[data-member-locked="1"] .channel-name').allInnerTexts();
const freeNames = await page.locator('.channel-row:not([data-member-locked="1"]) .channel-name').allInnerTexts();
console.log(JSON.stringify({ locked, free, lockedNames, freeNames }, null, 2));

const shot1 = resolve(__dir, "membership-messages-list-guest.png");
const shot2 = resolve(__dir, "membership-messages-locked-channel.png");
const shot3 = resolve(__dir, "membership-messages-unlocked-channel.png");

await page.screenshot({ path: shot1, fullPage: false });
console.log("wrote", shot1);

const firstLocked = page.locator('.channel-row[data-member-locked="1"]').first();
await firstLocked.click();
await page.waitForSelector(".show-member-msg-lock .mlock, .mlock", { timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: shot2, fullPage: false });
console.log("wrote", shot2);

if (free < 1) {
  console.log("NO_FREE_CHANNEL");
} else {
  const firstFree = page.locator('.channel-row:not([data-member-locked="1"])').first();
  await firstFree.click();
  await page.waitForFunction(() => !document.querySelector(".show-member-msg-lock, .mlock"), { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot3, fullPage: false });
  console.log("wrote", shot3);
}

await browser.close();
console.log("done");
