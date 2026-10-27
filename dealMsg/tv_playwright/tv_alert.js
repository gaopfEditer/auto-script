/**
 * TradingView 信号监听（告警）自动化 — CDP 9222
 *
 * 创建：条件选 BB-Wicks +「任何 alert() 函数调用」
 * 删除：按告警名称匹配
 *
 * 用法:
 *   node tv_alert.js --cdp http://127.0.0.1:9222 --action create --symbol ETHUSDT --interval 15
 *   node tv_alert.js --cdp http://127.0.0.1:9222 --action remove --symbol ETHUSDT --interval 15
 *   node tv_alert.js --cdp http://127.0.0.1:9222 --action list
 *
 * 成功时 stdout 最后一行 JSON: {"ok":true,...}
 */
const { setTimeout: sleep } = require("timers/promises");

let chromium;
let StealthPlugin;
try {
  ({ chromium } = require("playwright-extra"));
  StealthPlugin = require("playwright-extra-plugin-stealth");
} catch (e) {
  emit({ ok: false, error: `缺少 playwright 依赖: ${e.message}` });
  process.exit(1);
}
chromium.use(StealthPlugin());

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {
    cdp: process.env.CHROME_CDP_URL || "http://127.0.0.1:9222",
    action: "create",
    symbol: "",
    interval: "15",
    indicator: process.env.TV_ALERT_INDICATOR || "BB-Wicks",
    timeout: 120000,
    exchange: process.env.TV_ALERT_EXCHANGE || "BINANCE",
    perpetual: !["0", "false", "no", "off"].includes(
      String(process.env.TV_ALERT_PERPETUAL ?? "1").toLowerCase()
    ),
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--cdp") out.cdp = a[++i] || out.cdp;
    else if (a[i] === "--action") out.action = a[++i] || out.action;
    else if (a[i] === "--symbol") out.symbol = a[++i] || "";
    else if (a[i] === "--interval") out.interval = String(a[++i] || out.interval);
    else if (a[i] === "--indicator") out.indicator = a[++i] || out.indicator;
    else if (a[i] === "--timeout") out.timeout = parseInt(a[++i] || "120000", 10);
  }
  return out;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.error("[tv-alert]", ...args);
}

function normalizeSymbol(sym) {
  let s = String(sym || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (!s.endsWith("USDT") && !s.endsWith("USD")) s = `${s}USDT`;
  return s;
}

function tvInterval(interval) {
  const raw = String(interval || "15").trim().toLowerCase();
  if (raw === "15" || raw === "15m") return "15";
  if (raw === "60" || raw === "1h" || raw === "60m") return "60";
  if (raw.endsWith("m")) return raw.slice(0, -1);
  if (raw.endsWith("h")) return String(Number(raw.slice(0, -1)) * 60);
  return raw;
}

function alertName(symbol, interval, indicator) {
  return `${indicator} ${normalizeSymbol(symbol)} ${tvInterval(interval)}m`.replace(
    /60m$/,
    "1h"
  );
}

function chartUrl(opts) {
  const sym = normalizeSymbol(opts.symbol);
  const iv = tvInterval(opts.interval);
  const ticker = opts.perpetual ? `${sym}.P` : sym;
  return `https://www.tradingview.com/chart/?symbol=${opts.exchange}:${ticker}&interval=${iv}`;
}

async function pickTvPage(context) {
  const pages = context.pages();
  for (const p of pages) {
    const u = p.url() || "";
    if (/tradingview\.com/i.test(u)) return p;
  }
  return context.newPage();
}

async function clickFirstVisible(page, selectors, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
          await loc.click({ timeout: 2000 });
          return true;
        }
      } catch {
        /* continue */
      }
    }
    await sleep(200);
  }
  return false;
}

async function openCreateAlertDialog(page) {
  // 优先快捷键
  await page.keyboard.press("Alt+A").catch(() => {});
  await sleep(800);
  const dialog = page.locator('[data-name="alerts-create-edit-dialog"], [data-name="create-alert-dialog"], [class*="dialog"][class*="alert"]').first();
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) return true;

  // 工具栏闹钟按钮
  await clickFirstVisible(page, [
    'button[aria-label*="Alert" i]',
    'button[aria-label*="提醒" i]',
    'button[aria-label*="告警" i]',
    '[data-name="alerts"]',
    '[data-tooltip*="Alert" i]',
    '[data-tooltip*="提醒" i]',
  ]);
  await sleep(600);
  // 下拉「创建提醒」
  await clickFirstVisible(page, [
    'text=/^Create (an )?alert$/i',
    'text=/创建(一个)?提醒/',
    'text=/添加提醒/',
    '[data-name="create-alert"]',
  ]);
  await sleep(800);
  return page
    .locator('[data-name="alerts-create-edit-dialog"], [data-name="create-alert-dialog"], div[role="dialog"]')
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);
}

/**
 * 在创建提醒对话框里：选指标 BB-Wicks + Any alert() function call
 */
async function configureBbWicksCondition(page, indicator) {
  const dialog = page.locator('div[role="dialog"]').filter({ hasText: /alert|提醒|条件|Condition/i }).first();
  const root = (await dialog.count()) ? dialog : page;

  // 点开条件选择器（第一行）
  const conditionTriggers = [
    root.locator('[data-name="condition-select"], [class*="condition"]').first(),
    root.getByRole("button", { name: /condition|条件|指标|indicator/i }).first(),
    root.locator('button').filter({ hasText: /Moving Average|指标|Condition|条件/i }).first(),
  ];
  for (const t of conditionTriggers) {
    if (await t.isVisible({ timeout: 800 }).catch(() => false)) {
      await t.click().catch(() => {});
      await sleep(400);
      break;
    }
  }

  // 搜索框输入 BB-Wicks
  const search = root.locator('input[placeholder*="Search" i], input[placeholder*="搜索"], input[type="search"]').first();
  if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
    await search.fill("");
    await search.type(indicator, { delay: 30 });
    await sleep(500);
  }

  // 点选 BB-Wicks
  const indOpt = page
    .locator(`[role="option"], [role="menuitem"], [data-name="menu-item"], div, span`)
    .filter({ hasText: new RegExp(`^\\s*${indicator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") })
    .first();
  if (await indOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
    await indOpt.click();
    await sleep(500);
  } else {
    // 模糊匹配
    const fuzzy = page.getByText(indicator, { exact: false }).first();
    if (await fuzzy.isVisible({ timeout: 2000 }).catch(() => false)) {
      await fuzzy.click();
      await sleep(500);
    } else {
      throw new Error(`未找到指标选项: ${indicator}（请确认图表布局已加载该指标）`);
    }
  }

  // 第二条件：任何 alert() 函数调用
  const anyFnTexts = [
    /任何\s*alert\(\)\s*函数调用/,
    /Any\s*alert\(\)\s*function\s*call/i,
    /alert\(\)\s*function\s*call/i,
  ];
  let pickedFn = false;
  for (const re of anyFnTexts) {
    const loc = page.getByText(re).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await loc.click();
      pickedFn = true;
      await sleep(300);
      break;
    }
  }
  if (!pickedFn) {
    // 再点开第二个下拉
    const second = root.locator('[data-name="operator-select"], button').nth(1);
    if (await second.isVisible({ timeout: 1000 }).catch(() => false)) {
      await second.click();
      await sleep(400);
      for (const re of anyFnTexts) {
        const loc = page.getByText(re).first();
        if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
          await loc.click();
          pickedFn = true;
          break;
        }
      }
    }
  }
  if (!pickedFn) {
    throw new Error("未找到「任何 alert() 函数调用」选项");
  }
  return true;
}

async function setAlertName(page, name) {
  const inputs = page.locator(
    'div[role="dialog"] input[data-name="alert-name"], div[role="dialog"] input[placeholder*="name" i], div[role="dialog"] input[placeholder*="名称"]'
  );
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const inp = inputs.nth(i);
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill(name);
      return true;
    }
  }
  // 有的版本名称在「Notifications」旁的顶部输入
  const any = page.locator('div[role="dialog"] input').first();
  if (await any.isVisible().catch(() => false)) {
    const ph = ((await any.getAttribute("placeholder")) || "").toLowerCase();
    if (!ph.includes("search") && !ph.includes("搜索")) {
      await any.fill(name).catch(() => {});
    }
  }
  return false;
}

async function clickCreate(page) {
  const btn = page
    .locator('div[role="dialog"] button')
    .filter({ hasText: /^(Create|创建|Save|保存|确认)$/i })
    .last();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await sleep(1200);
    return true;
  }
  // 底部主按钮
  return clickFirstVisible(page, [
    'div[role="dialog"] button[name="submit"]',
    'div[role="dialog"] [data-name="submit-button"]',
  ]);
}

async function createAlert(page, opts) {
  const url = chartUrl(opts);
  const name = alertName(opts.symbol, opts.interval, opts.indicator);
  log("goto", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
  await page.waitForSelector("#chart-container, .chart-container, [class*='chart-container']", {
    timeout: 90000,
  }).catch(() => log("WARN chart container timeout"));
  await sleep(Number(process.env.TV_EXTRA_WAIT_MS || 5000));

  const opened = await openCreateAlertDialog(page);
  if (!opened) throw new Error("无法打开创建提醒对话框（Alt+A）");

  await configureBbWicksCondition(page, opts.indicator);
  await setAlertName(page, name);
  const created = await clickCreate(page);
  if (!created) throw new Error("未点到创建按钮");

  // 容量满弹窗？
  const full = page.getByText(/limit|上限|已满|maximum|too many/i).first();
  if (await full.isVisible({ timeout: 1500 }).catch(() => false)) {
    throw new Error("TradingView 提醒数量已满");
  }

  return { ok: true, action: "create", symbol: normalizeSymbol(opts.symbol), interval: tvInterval(opts.interval), name, url };
}

async function openAlertsPanel(page) {
  // 确保在 TV 站
  if (!/tradingview\.com/i.test(page.url())) {
    await page.goto("https://www.tradingview.com/chart/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3000);
  }
  await page.keyboard.press("Alt+T").catch(() => {});
  await sleep(600);
  const opened = await clickFirstVisible(page, [
    'button[aria-label*="Alert" i]',
    'button[aria-label*="提醒" i]',
    '[data-name="alerts"]',
    'text=/^Alerts$/i',
    'text=/提醒管理/',
    'text=/警报列表/',
  ]);
  await sleep(800);
  return opened;
}

async function removeAlert(page, opts) {
  const name = alertName(opts.symbol, opts.interval, opts.indicator);
  await openAlertsPanel(page);

  // 列表项
  const item = page.locator(`[data-name="alert"], [class*="alert"], li, div`).filter({ hasText: name }).first();
  if (!(await item.isVisible({ timeout: 5000 }).catch(() => false))) {
    // 模糊：symbol + interval
    const fuzzy = page
      .locator('[data-name="alert"], [class*="list"] [class*="item"], [role="listitem"]')
      .filter({ hasText: new RegExp(normalizeSymbol(opts.symbol), "i") })
      .filter({ hasText: new RegExp(`${tvInterval(opts.interval)}|1h|15`, "i") })
      .first();
    if (!(await fuzzy.isVisible({ timeout: 3000 }).catch(() => false))) {
      return { ok: true, action: "remove", skipped: true, reason: "alert_not_found", name };
    }
    await fuzzy.click({ button: "right" }).catch(async () => {
      await fuzzy.hover();
    });
  } else {
    await item.click({ button: "right" }).catch(async () => {
      await item.hover();
    });
  }
  await sleep(400);

  const deleted = await clickFirstVisible(page, [
    'text=/^Delete$/i',
    'text=/删除/',
    'text=/移除/',
    '[data-name="delete"]',
    'button:has-text("Delete")',
  ]);
  if (deleted) {
    await sleep(400);
    await clickFirstVisible(page, [
      'button:has-text("Delete")',
      'button:has-text("删除")',
      'button:has-text("确认")',
      'button:has-text("OK")',
    ]);
    await sleep(800);
  } else {
    // 悬停显示垃圾桶
    const row = page.locator(`[data-name="alert"]`).filter({ hasText: name }).first();
    if (await row.isVisible().catch(() => false)) {
      await row.hover();
      await clickFirstVisible(page, [
        'button[aria-label*="Delete" i]',
        'button[aria-label*="删除" i]',
        '[data-name="remove"]',
      ]);
      await sleep(400);
      await clickFirstVisible(page, ['button:has-text("Delete")', 'button:has-text("删除")']);
    }
  }

  return { ok: true, action: "remove", symbol: normalizeSymbol(opts.symbol), interval: tvInterval(opts.interval), name };
}

async function listAlerts(page) {
  await openAlertsPanel(page);
  await sleep(1000);
  const texts = await page.locator('[data-name="alert"], [class*="alert-item"], [role="listitem"]').allTextContents().catch(() => []);
  const names = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80);
  return { ok: true, action: "list", count: names.length, alerts: names };
}

async function main() {
  const opts = parseArgs();
  const action = String(opts.action || "create").toLowerCase();
  if ((action === "create" || action === "remove") && !normalizeSymbol(opts.symbol)) {
    emit({ ok: false, error: "symbol required" });
    process.exit(2);
  }

  log(`CDP ${opts.cdp} action=${action} symbol=${opts.symbol} interval=${opts.interval}`);
  const browser = await chromium.connectOverCDP(opts.cdp);
  const contexts = browser.contexts();
  const context = contexts.length ? contexts[0] : await browser.newContext();
  const page = await pickTvPage(context);
  await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});

  try {
    let result;
    if (action === "create") result = await createAlert(page, opts);
    else if (action === "remove") result = await removeAlert(page, opts);
    else if (action === "list") result = await listAlerts(page);
    else throw new Error(`unknown action: ${action}`);
    emit(result);
  } catch (e) {
    log("ERROR", e.message || e);
    emit({ ok: false, error: String(e.message || e), action, symbol: opts.symbol, interval: opts.interval });
    process.exitCode = 1;
  } finally {
    // 不关 browser：CDP 附着模式关 browser 会断连；只保留标签
  }
}

main().catch((e) => {
  emit({ ok: false, error: String(e.message || e) });
  process.exit(1);
});
