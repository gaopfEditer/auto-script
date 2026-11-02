/**
 * 巨鲸侧栏：分组（data-open-grp）内频道（data-open-ch）展开与点击。
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {unknown[]} targets
 * @param {(el: unknown) => boolean} isVisible
 * @param {(el: unknown) => number} getDepth
 */
export function pickKolvipChannelTarget(targets, isVisible, getDepth) {
  if (!targets.length) return null;
  const visible = targets.find(isVisible);
  if (visible) return visible;
  let best = targets[0];
  let bestDepth = getDepth(best);
  for (const t of targets) {
    const d = getDepth(t);
    if (d > bestDepth) {
      best = t;
      bestDepth = d;
    }
  }
  return best;
}

/**
 * @param {unknown[]} headers
 * @param {(el: unknown) => number} getDepth
 */
export function sortKolvipGroupHeadersOuterFirst(headers, getDepth) {
  return [...headers].sort((a, b) => getDepth(a) - getDepth(b));
}

/**
 * @param {import("playwright").Page} page
 * @param {string} kolvipChannelId
 * @param {{ clickTimeoutMs?: number, log?: { debug?: Function } }} [opts]
 */
export async function openKolvipChannelInSidebar(page, kolvipChannelId, opts = {}) {
  const ch = String(kolvipChannelId ?? "").trim();
  const clickTimeout = opts.clickTimeoutMs ?? 20_000;

  const openResult = await page.evaluate((channelId) => {
    const chId = String(channelId).trim();

    /** @param {Element | null | undefined} el */
    function depth(el) {
      let d = 0;
      let n = el;
      while (n?.parentElement) {
        d += 1;
        n = n.parentElement;
      }
      return d;
    }

    /** @param {Element | null | undefined} el */
    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    }

    /** @param {Element} channelEl */
    function findGroupHeadersToExpand(channelEl) {
      /** @type {Element[]} */
      const headers = [];
      const seen = new Set();
      const add = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        headers.push(el);
      };

      for (const g of document.querySelectorAll("[data-open-grp]")) {
        if (g === channelEl) continue;
        if (g.contains(channelEl)) add(g);
      }

      let block = channelEl.parentElement;
      while (block && block !== document.body) {
        const prev = block.previousElementSibling;
        if (prev instanceof Element && prev.hasAttribute("data-open-grp")) add(prev);
        block = block.parentElement;
      }

      headers.sort((a, b) => depth(a) - depth(b));
      return headers;
    }

    const targets = [...document.querySelectorAll(`[data-open-ch="${chId}"]`)];
    if (!targets.length) {
      return { ok: false, error: `not_found:${chId}` };
    }

    targets.sort((a, b) => depth(b) - depth(a));
    let target =
      targets.find(isVisible) ||
      targets.reduce((best, cur) => (depth(cur) > depth(best) ? cur : best));

    for (let round = 0; round < 14 && !isVisible(target); round += 1) {
      const headers = findGroupHeadersToExpand(target);
      if (!headers.length) break;
      for (const h of headers) {
        if (isVisible(target)) break;
        h.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    }

    target.scrollIntoView({ block: "center", inline: "nearest" });
    if (!isVisible(target)) {
      return { ok: false, error: `not_visible:${chId}` };
    }

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { ok: true, error: "" };
  }, ch);

  if (!openResult?.ok) {
    opts.log?.debug?.(
      `巨鲸 DOM 打开频道 fallback ch=${ch} reason=${openResult?.error ?? "unknown"}`
    );
    await expandKolvipGroupsPlaywright(page, ch);
    const loc = page.locator(`[data-open-ch="${ch}"]`).locator("visible=true").first();
    await loc.waitFor({ state: "visible", timeout: clickTimeout });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: clickTimeout });
  } else {
    await sleep(350);
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {string} kolvipChannelId
 */
async function expandKolvipGroupsPlaywright(page, kolvipChannelId) {
  const ch = String(kolvipChannelId).trim();
  for (let i = 0; i < 14; i += 1) {
    const visibleCount = await page.locator(`[data-open-ch="${ch}"]`).locator("visible=true").count();
    if (visibleCount > 0) return;

    const clicked = await page.evaluate((channelId) => {
      const chId = String(channelId).trim();
      const target = document.querySelector(`[data-open-ch="${chId}"]`);
      if (!target) return false;

      /** @param {Element} channelEl */
      function findHeaders(channelEl) {
        const headers = [];
        const seen = new Set();
        const add = (el) => {
          if (!el || seen.has(el)) return;
          seen.add(el);
          headers.push(el);
        };
        for (const g of document.querySelectorAll("[data-open-grp]")) {
          if (g.contains(channelEl)) add(g);
        }
        let block = channelEl.parentElement;
        while (block && block !== document.body) {
          const prev = block.previousElementSibling;
          if (prev instanceof Element && prev.hasAttribute("data-open-grp")) add(prev);
          block = block.parentElement;
        }
        return headers;
      }

      const headers = findHeaders(target);
      if (!headers.length) return false;
      headers[0].click();
      return true;
    }, ch);

    if (!clicked) break;
    await sleep(450);
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {number} [timeoutMs]
 */
export async function waitForKolvipFeedAttached(page, timeoutMs = 18_000) {
  await page
    .locator("#v-channel #feed.feed #msgs, #feed.feed #msgs, #msgs")
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .catch(() => {});
  await sleep(500);
}

/**
 * @param {import("playwright").Page} page
 * @param {number} passes
 */
export async function scrollKolvipFeedUp(page, passes = 3) {
  for (let i = 0; i < passes; i += 1) {
    await page.evaluate(() => {
      const feed =
        document.querySelector("#v-channel #feed.feed") ||
        document.querySelector("#feed.feed");
      const scroller = feed?.querySelector(".scroll, .scroller") || feed || document.querySelector("#msgs");
      if (!scroller) return;
      if ("scrollTop" in scroller) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 800);
      }
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
    });
    await sleep(600);
  }
}
