(() => {
  const timeline = document.getElementById("timeline");
  const boards = document.getElementById("boards");
  const macroHint = document.getElementById("macroHint");
  const hotHint = document.getElementById("hotHint");
  const statusEl = document.getElementById("status");
  const btn = document.getElementById("btnRefresh");
  const btnToggle = document.getElementById("btnToggle");
  const macroTabs = document.querySelector(".macro-tabs");
  const sourceFilters = document.getElementById("sourceFilters");
  const btnSourceAll = document.getElementById("btnSourceAll");

  /** @type {"economy"|"crypto"} */
  let macroChannel = "economy";
  /** @type {{economy: any[], crypto: any[], min_star?: number, ahead_hours?: number, behind_hours?: number}} */
  let macroCache = { economy: [], crypto: [] };
  /** @type {any[]} */
  let boardsCache = [];
  let boardsUpdatedAt = "";

  const SOURCE_KEY = "news_hot_sources_v1";
  const SOURCE_META = {
    binance: "币安",
    okx: "OKX",
    foresight: "Foresight",
    coindesk: "CoinDesk",
    blockbeats: "BlockBeats",
  };

  /** 本机才显示「立即刷新」并允许 POST 抓取（生产 iframe 只读缓存） */
  function isNewsOperator() {
    const h = String(location.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }

  const newsOperator = isNewsOperator();
  if (btn && !newsOperator) {
    btn.hidden = true;
    btn.setAttribute("aria-hidden", "true");
  }

  /** @type {Record<string, boolean>} */
  let sourceEnabled = loadSourceEnabled();

  function loadSourceEnabled() {
    /** @type {Record<string, boolean>} */
    const base = {};
    for (const k of Object.keys(SOURCE_META)) base[k] = true;
    try {
      const raw = localStorage.getItem(SOURCE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return base;
      for (const k of Object.keys(SOURCE_META)) {
        if (typeof parsed[k] === "boolean") base[k] = parsed[k];
      }
      return base;
    } catch {
      return base;
    }
  }

  function saveSourceEnabled() {
    try {
      localStorage.setItem(SOURCE_KEY, JSON.stringify(sourceEnabled));
    } catch (_) {}
  }

  function isSourceOn(platform) {
    const p = String(platform || "");
    if (!(p in sourceEnabled)) return true;
    return sourceEnabled[p] !== false;
  }

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  /** iframe 内 target=_blank 常被拦截；优先顶层新开源站 */
  function openExternal(url) {
    const u = String(url || "").trim();
    if (!u || u === "#") return false;
    try {
      const w = window.top || window;
      const opened = w.open(u, "_blank", "noopener,noreferrer");
      if (opened) return true;
    } catch (_) {}
    try {
      const a = document.createElement("a");
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch (_) {
      return false;
    }
  }

  function stars(n) {
    const k = Math.max(0, Math.min(5, Number(n) || 0));
    return "★".repeat(k) + "☆".repeat(5 - k);
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return iso || "";
    }
  }

  function channelLabel(ch) {
    return ch === "crypto" ? "币圈事件" : "经济事件";
  }

  function channelEmpty(ch) {
    return ch === "crypto"
      ? "暂无币圈事件<br/>需成功抓取 PANews 日历后展示"
      : "暂无经济事件<br/>需成功抓取金十日历后展示";
  }

  function renderMacro(items, ch) {
    const channel = ch || macroChannel;
    if (!items.length) {
      timeline.innerHTML = `<p class="empty">${channelEmpty(channel)}</p>`;
      return;
    }
    const sorted = [...items].sort(
      (a, b) => Date.parse(a.publish_at || "") - Date.parse(b.publish_at || ""),
    );
    const firstUp = sorted.findIndex((e) => e.phase !== "past");
    const parts = [];
    sorted.forEach((e, i) => {
      if (firstUp >= 0 && i === firstUp) {
        parts.push('<div class="tl-now">现在 · 北京时间</div>');
      }
      const bc = e.bias === "bullish" || e.bias === "bearish" ? e.bias : "neutral";
      const nums = [
        e.previous != null ? `<span>前值 <strong>${esc(e.previous)}</strong></span>` : "",
        e.consensus != null ? `<span>预期 <strong>${esc(e.consensus)}</strong></span>` : "",
        e.actual != null ? `<span>公布 <strong>${esc(e.actual)}</strong></span>` : "",
      ]
        .filter(Boolean)
        .join("");
      const tag =
        channel === "crypto" || e.source === "panews"
          ? e.category || "PANews"
          : e.country || "金十";
      const titleHtml = e.source_url
        ? `<a class="tl-title" href="${esc(e.source_url)}" data-url="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>`
        : `<div class="tl-title">${esc(e.title)}</div>`;
      const starHtml =
        channel === "economy" ? `<span class="stars">${stars(e.star)}</span>` : "";
      parts.push(`
<article class="tl-item ${bc} ${e.phase === "past" ? "past" : "upcoming"}">
  <div class="tl-meta">
    <span>${esc(fmtTime(e.publish_at))}</span>
    <span class="src">${esc(tag)}</span>
    ${starHtml}
    <span class="bias ${bc}">${esc(e.bias_label || "中性")}</span>
  </div>
  ${titleHtml}
  ${nums ? `<div class="nums">${nums}</div>` : ""}
</article>`);
    });
    timeline.innerHTML = parts.join("");
  }

  function applyMacroChannel() {
    const items = macroCache[macroChannel] || [];
    renderMacro(items, macroChannel);
    const starBit =
      macroChannel === "economy"
        ? `≥${macroCache.min_star ?? 3}★ · `
        : "";
    macroHint.textContent = `${channelLabel(macroChannel)} · ${starBit}过去${macroCache.behind_hours ?? 72}h～未来${macroCache.ahead_hours ?? 72}h · ${items.length} 条`;
    macroTabs?.querySelectorAll(".macro-tab").forEach((btn) => {
      const on = btn.getAttribute("data-channel") === macroChannel;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  const modal = document.getElementById("itemModal");
  const modalTitle = document.getElementById("modalTitle");
  const modalMeta = document.getElementById("modalMeta");
  const modalSummary = document.getElementById("modalSummary");
  const modalTags = document.getElementById("modalTags");
  const modalOpen = document.getElementById("modalOpen");
  let modalUrl = "";

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    modalUrl = "";
  }

  function openItemModal(payload) {
    if (!modal || !modalTitle) return;
    const title = String(payload.title || "").trim() || "(无标题)";
    const platform = String(payload.platform || "").trim();
    const rank = payload.rank != null ? String(payload.rank) : "";
    const summary = String(payload.summary || "").trim();
    const tags = Array.isArray(payload.tags) ? payload.tags.filter(Boolean) : [];
    const pubTime = payload.published_at ? fmtTime(payload.published_at) : "";
    modalUrl = String(payload.url || "").trim();

    modalTitle.textContent = title;
    if (modalMeta) {
      const metaParts = [platform, rank ? `#${rank}` : "", pubTime].filter(Boolean);
      modalMeta.textContent = metaParts.join(" · ");
    }
    if (modalSummary) {
      if (summary) {
        modalSummary.hidden = false;
        modalSummary.textContent = summary;
      } else {
        modalSummary.hidden = true;
        modalSummary.textContent = "";
      }
    }
    if (modalTags) {
      if (tags.length) {
        modalTags.hidden = false;
        modalTags.textContent = tags.slice(0, 8).join(" · ");
      } else {
        modalTags.hidden = true;
        modalTags.textContent = "";
      }
    }
    if (modalOpen) {
      modalOpen.disabled = !modalUrl || modalUrl === "#";
    }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function renderSourceFilters(list) {
    if (!sourceFilters) return;
    const plats = [];
    const seen = new Set();
    for (const b of list || []) {
      const p = String(b.platform || "");
      if (!p || seen.has(p)) continue;
      seen.add(p);
      plats.push(p);
      if (!(p in sourceEnabled)) sourceEnabled[p] = true;
    }
    // 保证已知源也出现（即使暂无数据）
    for (const p of Object.keys(SOURCE_META)) {
      if (!seen.has(p)) {
        plats.push(p);
        seen.add(p);
        if (!(p in sourceEnabled)) sourceEnabled[p] = true;
      }
    }
    sourceFilters.innerHTML = plats
      .map((p) => {
        const on = isSourceOn(p);
        const label = SOURCE_META[p] || p;
        return `<button type="button" class="source-chip ${esc(p)} ${on ? "on" : "off"}" data-platform="${esc(p)}" aria-pressed="${on ? "true" : "false"}">${esc(label)}</button>`;
      })
      .join("");
  }

  function applyBoards() {
    const visible = (boardsCache || []).filter((b) => isSourceOn(b.platform));
    renderBoards(visible);
    const total = visible.reduce((n, b) => n + (b.items?.length || 0), 0);
    const onLabels = visible
      .map((b) => SOURCE_META[b.platform] || b.label || b.platform)
      .filter(Boolean);
    hotHint.textContent = onLabels.length
      ? `更新 ${boardsUpdatedAt || "—"} · ${onLabels.join(" · ")} · ${total} 条`
      : "未选择任何源 · 点击上方芯片开启";
    renderSourceFilters(boardsCache);
  }

  function renderBoards(list) {
    if (!list.length) {
      boards.innerHTML =
        boardsCache.length && !(boardsCache || []).some((b) => isSourceOn(b.platform))
          ? '<p class="empty">已隐藏全部源<br/>点击上方芯片重新开启</p>'
          : newsOperator
            ? '<p class="empty">暂无热榜<br/>请点「立即刷新」</p>'
            : '<p class="empty">暂无热榜<br/>等待本机进程写入缓存</p>';
      return;
    }
    boards.innerHTML = list
      .map((b) => {
        const boardUrl = b.source_url || "#";
        const platformLabel = b.label || b.platform || "";
        const items = b.items || [];
        const lis = items.length
          ? items
              .map((it) => {
                const href = it.url || boardUrl;
                const pubTime = it.published_at ? fmtTime(it.published_at) : "";
                const payload = esc(
                  JSON.stringify({
                    title: it.title || "",
                    summary: it.summary || "",
                    tags: it.tags || [],
                    url: href,
                    platform: platformLabel,
                    rank: it.rank,
                    published_at: it.published_at || null,
                  }),
                );
                return `
<li>
  <button type="button" class="item-row" data-item="${payload}" title="查看详情">
    <span class="rank">${esc(it.rank)}</span>
    ${pubTime ? `<span class="item-time">${esc(pubTime)}</span>` : ""}
    <span class="item-body">
      <div class="item-title">${esc(it.title)}</div>
      ${it.summary ? `<div class="item-sub">${esc(it.summary)}</div>` : ""}
      ${(it.tags || []).length ? `<div class="item-sub">${esc((it.tags || []).slice(0, 4).join(" · "))}</div>` : ""}
    </span>
    <span class="item-more">详情</span>
  </button>
</li>`;
              })
              .join("")
          : '<li><p class="empty">该源暂无数据</p></li>';
        return `
<section class="board ${esc(b.platform)}">
  <div class="board-head">
    <h3><a href="${esc(boardUrl)}" data-url="${esc(boardUrl)}" target="_blank" rel="noopener noreferrer">${esc(platformLabel)}</a></h3>
    <a class="board-src" href="${esc(boardUrl)}" data-url="${esc(boardUrl)}" target="_blank" rel="noopener noreferrer">官网</a>
  </div>
  <ol class="board-list">${lis}</ol>
</section>`;
      })
      .join("");
  }

  async function loadMacro(refresh) {
    const q = refresh ? "?refresh=1&channel=all" : "?channel=all";
    const res = await fetch(`/api/v1/macro/timeline${q}`);
    const data = await res.json();
    if (!data.ok) {
      timeline.innerHTML = `<p class="err">${esc(data.error || "宏观加载失败")}</p>`;
      return;
    }
    macroCache = {
      economy: data.economy || [],
      crypto: data.crypto || [],
      min_star: data.min_star,
      ahead_hours: data.ahead_hours,
      behind_hours: data.behind_hours,
    };
    applyMacroChannel();
  }

  async function loadHot(refresh) {
    const q = refresh ? "?refresh=1" : "";
    const res = await fetch(`/api/v1/hotlists${q}`);
    const data = await res.json();
    if (!data.ok) {
      boards.innerHTML = `<p class="err">${esc(data.error || "热榜加载失败")}</p>`;
      return;
    }
    boardsCache = data.boards || [];
    boardsUpdatedAt = data.updated_at || "";
    applyBoards();
  }

  async function refreshAll(force) {
    const doFetch = Boolean(force && newsOperator);
    statusEl.textContent = doFetch ? "刷新中…" : "加载中…";
    try {
      if (doFetch) {
        await fetch("/api/v1/refresh", { method: "POST" });
      }
      // 生产端永不带 refresh=1，只读落盘缓存
      await Promise.all([loadMacro(false), loadHot(false)]);
      statusEl.textContent = "已更新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    } catch (e) {
      statusEl.textContent = "加载失败";
    }
  }

  /** 自动刷新状态：null=未加载，true=开启，false=暂停 */
  let autoRefresh = null;

  function updateToggleBtn() {
    if (!btnToggle) return;
    if (autoRefresh === null) {
      btnToggle.textContent = "…";
      btnToggle.disabled = true;
    } else {
      btnToggle.textContent = autoRefresh ? "暂停" : "开启";
      btnToggle.disabled = false;
      btnToggle.classList.toggle("paused", !autoRefresh);
    }
  }

  async function loadToggleState() {
    if (!newsOperator) return;
    try {
      const res = await fetch("/api/v1/fetch/status");
      const json = await res.json();
      autoRefresh = json.auto_refresh ?? true;
    } catch (_) {
      autoRefresh = true;
    }
    updateToggleBtn();
  }

  async function toggleAutoRefresh() {
    if (autoRefresh === null) return;
    btnToggle.disabled = true;
    statusEl.textContent = "切换中…";
    try {
      const res = await fetch("/api/v1/fetch/toggle", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        autoRefresh = json.auto_refresh;
        statusEl.textContent = autoRefresh ? "已开启自动刷新" : "已暂停自动刷新";
      } else {
        statusEl.textContent = "切换失败";
      }
    } catch (_) {
      statusEl.textContent = "切换失败";
    }
    updateToggleBtn();
  }

  if (newsOperator) {
    btn?.addEventListener("click", () => refreshAll(true));
    btnToggle?.addEventListener("click", toggleAutoRefresh);
  } else {
    // 非本机：隐藏操作按钮
    if (btn) { btn.hidden = true; btn.setAttribute("aria-hidden", "true"); }
    if (btnToggle) { btnToggle.hidden = true; btnToggle.setAttribute("aria-hidden", "true"); }
  }

  sourceFilters?.addEventListener("click", (ev) => {
    const chip =
      ev.target && ev.target.closest ? ev.target.closest("button.source-chip[data-platform]") : null;
    if (!chip) return;
    const p = chip.getAttribute("data-platform");
    if (!p) return;
    sourceEnabled[p] = !isSourceOn(p);
    saveSourceEnabled();
    applyBoards();
  });

  btnSourceAll?.addEventListener("click", () => {
    const plats = new Set([
      ...Object.keys(SOURCE_META),
      ...(boardsCache || []).map((b) => String(b.platform || "")).filter(Boolean),
    ]);
    const allOn = [...plats].every((p) => isSourceOn(p));
    for (const p of plats) sourceEnabled[p] = !allOn;
    saveSourceEnabled();
    applyBoards();
  });

  macroTabs?.addEventListener("click", (ev) => {
    const tab = ev.target && ev.target.closest ? ev.target.closest(".macro-tab") : null;
    if (!tab) return;
    const ch = tab.getAttribute("data-channel");
    if (ch !== "economy" && ch !== "crypto") return;
    if (ch === macroChannel) return;
    macroChannel = ch;
    applyMacroChannel();
  });

  // 热榜行：开弹窗（不直接跳转）
  document.addEventListener("click", (ev) => {
    const row =
      ev.target && ev.target.closest ? ev.target.closest("button.item-row[data-item]") : null;
    if (row) {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        openItemModal(JSON.parse(row.getAttribute("data-item") || "{}"));
      } catch (_) {
        /* ignore */
      }
      return;
    }

    if (ev.target && ev.target.closest && ev.target.closest("[data-close-modal]")) {
      closeModal();
      return;
    }

    if (ev.target === modalOpen || (ev.target && ev.target.closest && ev.target.closest("#modalOpen"))) {
      ev.preventDefault();
      if (modalUrl) openExternal(modalUrl);
      return;
    }

    // 宏观标题 / 榜单官网：保证从 Vue iframe 也能跳出到源站
    const a =
      ev.target && ev.target.closest
        ? ev.target.closest("a[data-url], a.tl-title, a.board-src, .board-head h3 a")
        : null;
    if (!a) return;
    const url = a.getAttribute("data-url") || a.getAttribute("href") || "";
    if (!url || url === "#" || url.startsWith("javascript:")) return;
    ev.preventDefault();
    ev.stopPropagation();
    openExternal(url);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && modal && !modal.hidden) closeModal();
  });

  refreshAll(false);
  loadToggleState();
  // 仅读缓存；抓取节奏由后台宏观 8h / 热榜 1h 控制
  setInterval(() => refreshAll(false), 5 * 60_000);
})();
