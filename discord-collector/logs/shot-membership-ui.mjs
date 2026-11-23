/**
 * Headless Playwright screenshots for the local membership UI.
 * Uses Playwright's bundled Chromium only (no Chrome 9222/9223).
 * Init script writes only into this headless context.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = __dir;
const base = "http://127.0.0.1:3851";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
});

/**
 * @param {{ isMember: boolean, planId?: string }} state
 */
async function newPage(state) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "zh-CN",
  });
  await context.addInitScript((s) => {
    localStorage.setItem("discord-collector.onboarding.v2", "1");
    localStorage.setItem(
      "discord-collector.membership.v1",
      JSON.stringify({ isMember: s.isMember, planId: s.planId || "quarterly" }),
    );
    localStorage.removeItem("discord-collector.membership.messages.v1");
  }, state);
  const page = await context.newPage();
  return { context, page };
}

/** @param {import('playwright').Page} page */
async function waitShell(page) {
  await page.waitForSelector(".member-switch", { timeout: 20000 });
  await page.waitForTimeout(600);
}

const shot1 = resolve(outDir, "membership-member-toggle.png");
const shot2 = resolve(outDir, "membership-center-guest.png");
const shot3 = resolve(outDir, "membership-contact-modal.png");
const shot4 = resolve(outDir, "membership-locked-kolvip-sig.png");

{
  const { context, page } = await newPage({ isMember: true });
  await page.goto(`${base}/local/manual-stats/kolvip-sig`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitShell(page);
  await page.waitForSelector("text=博主胜率", { timeout: 20000 });
  await page.screenshot({ path: shot1, fullPage: false });
  await context.close();
  console.log("wrote", shot1);
}

{
  const { context, page } = await newPage({ isMember: false, planId: "quarterly" });
  await page.goto(`${base}/local/membership`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitShell(page);
  await page.waitForSelector("text=会员中心", { timeout: 20000 });
  await page.waitForSelector("text=50U", { timeout: 10000 });
  await page.waitForSelector("text=998U", { timeout: 10000 });
  await page.screenshot({ path: shot2, fullPage: false });

  await page.getByRole("button", { name: /联系客服开通/ }).click();
  await page.waitForSelector(".cs-modal", { timeout: 10000 });
  await page.waitForSelector("text=本地客服", { timeout: 10000 });
  await page.waitForSelector("text=【会员开通】我想开通会员", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot3, fullPage: false });
  await context.close();
  console.log("wrote", shot2);
  console.log("wrote", shot3);
}

{
  const { context, page } = await newPage({ isMember: false });
  await page.goto(`${base}/local/manual-stats/kolvip-sig`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitShell(page);
  await page.waitForSelector(".mlock", { timeout: 20000 });
  await page.screenshot({ path: shot4, fullPage: false });
  await context.close();
  console.log("wrote", shot4);
}

await browser.close();
console.log("done");
