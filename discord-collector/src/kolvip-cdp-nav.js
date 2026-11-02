/**
 * 巨鲸侧栏：分组 `[data-open-grp]` 展开后再点 `[data-open-ch]`。
 */

/** @param {Element | null | undefined} el */
export function isKolvipDomVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) {
    return false;
  }
  return true;
}

/**
 * 从频道按钮向上收集分组节点，顺序为 **外层 → 内层**。
 * @param {Element} channelOpener
 * @returns {Element[]}
 */
export function listKolvipGroupAncestorsOuterToInner(channelOpener) {
  /** @type {Element[]} */
  const innerToOuter = [];
  let el = channelOpener.parentElement;
  while (el) {
    if (el.hasAttribute("data-open-grp")) innerToOuter.push(el);
    el = el.parentElement;
  }
  return innerToOuter.reverse();
}

/**
 * @param {Document | Element} root
 * @param {string} kolvipChannelId
 * @returns {Element[]}
 */
export function findKolvipChannelOpeners(root, kolvipChannelId) {
  const ch = String(kolvipChannelId ?? "").trim();
  if (!ch) return [];
  const sel = `[data-open-ch="${ch}"]`;
  if (root && typeof root.querySelectorAll === "function") {
    return [...root.querySelectorAll(sel)];
  }
  return [];
}

/**
 * 在页面内展开分组并点击可见频道入口（供 CDP evaluate 或单测 mock DOM）。
 * @param {Document} document
 * @param {string} kolvipChannelId
 * @returns {{ ok: boolean, reason?: string, groupCount?: number }}
 */
export function domOpenKolvipChannel(document, kolvipChannelId) {
  const openers = findKolvipChannelOpeners(document, kolvipChannelId);
  if (!openers.length) {
    return { ok: false, reason: `no-opener-${kolvipChannelId}` };
  }

  let target =
    openers.find((el) => isKolvipDomVisible(el)) ||
    openers[openers.length - 1] ||
    openers[0];

  const groups = listKolvipGroupAncestorsOuterToInner(target);
  for (const grp of groups) {
    if (!isKolvipDomVisible(target)) {
      grp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
  }

  if (!isKolvipDomVisible(target)) {
    for (const opener of openers) {
      if (isKolvipDomVisible(opener)) {
        target = opener;
        break;
      }
    }
  }

  if (!isKolvipDomVisible(target)) {
    return { ok: false, reason: "channel-not-visible", groupCount: groups.length };
  }

  target.scrollIntoView({ block: "nearest", inline: "nearest" });
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { ok: true, groupCount: groups.length };
}

/**
 * @param {import("playwright").Page} page
 * @param {string} kolvipChannelId
 */
export async function openKolvipChannelInSidebar(page, kolvipChannelId) {
  const ch = String(kolvipChannelId).trim();
  const result = await page.evaluate((channelId) => {
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) {
        return false;
      }
      return true;
    };
    const openers = [...document.querySelectorAll(`[data-open-ch="${channelId}"]`)];
    if (!openers.length) return { ok: false, reason: "no-opener" };
    let target = openers.find(isVisible) || openers[openers.length - 1] || openers[0];
    /** @type {Element[]} */
    const groups = [];
    let walk = target.parentElement;
    while (walk) {
      if (walk.hasAttribute("data-open-grp")) groups.unshift(walk);
      walk = walk.parentElement;
    }
    for (const grp of groups) {
      if (!isVisible(target)) {
        grp.click();
      }
    }
    if (!isVisible(target)) {
      for (const opener of openers) {
        if (isVisible(opener)) {
          target = opener;
          break;
        }
      }
    }
    if (!isVisible(target)) {
      return { ok: false, reason: "channel-not-visible", groupCount: groups.length };
    }
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    target.click();
    return { ok: true, groupCount: groups.length };
  }, ch);

  if (!result?.ok) {
    const opener = page.locator(`[data-open-ch="${ch}"]`).first();
    if (!(await opener.count())) {
      throw new Error(`未找到频道入口 data-open-ch="${ch}"（请确认已登录 kolvip.vip/web）`);
    }
    await expandKolvipGroupsPlaywright(page, ch);
    await opener.scrollIntoViewIfNeeded().catch(() => {});
    await opener.click({ timeout: 20_000 });
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {string} kolvipChannelId
 */
async function expandKolvipGroupsPlaywright(page, kolvipChannelId) {
  await page.evaluate((channelId) => {
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
    };
    const openers = [...document.querySelectorAll(`[data-open-ch="${channelId}"]`)];
    const target = openers[0];
    if (!target) return;
    /** @type {Element[]} */
    const groups = [];
    let walk = target.parentElement;
    while (walk) {
      if (walk.hasAttribute("data-open-grp")) groups.unshift(walk);
      walk = walk.parentElement;
    }
    for (const grp of groups) {
      if (!isVisible(target)) grp.click();
    }
  }, kolvipChannelId);
}

/**
 * @param {import("playwright").Page} page
 */
export async function waitForKolvipMsgsFeed(page) {
  await page
    .locator("#v-channel #feed.feed #msgs, #feed.feed #msgs, #msgs")
    .first()
    .waitFor({ state: "attached", timeout: 18_000 })
    .catch(() => {});
}
