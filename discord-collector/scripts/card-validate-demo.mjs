#!/usr/bin/env node
/**
 * 卡片列表验证 — 模拟数据联调脚本
 *
 * 用法（需 collect:ui 已启动）：
 *   node scripts/card-validate-demo.mjs
 *   node scripts/card-validate-demo.mjs --ws
 *   CARDS_API_KEY=xxx node scripts/card-validate-demo.mjs --v1
 */
const BASE = process.env.COLLECTOR_UI_URL ?? "http://127.0.0.1:3851";
const API_KEY = process.env.CARDS_API_KEY ?? "Gpf123456";
const useV1 = process.argv.includes("--v1");
const useWs = process.argv.includes("--ws");

function headers() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["X-Cards-Api-Key"] = API_KEY;
  return h;
}

function api(path) {
  return useV1 ? `/api/v1${path.replace(/^\/api/, "")}` : path;
}

async function main() {
  console.log("=== 1) 静态样例 GET ===");
  const sampleUrl = `${BASE}${api("/cards/validate/mock/sample")}`;
  const sampleRes = await fetch(sampleUrl, { headers: headers() });
  const sample = await sampleRes.json();
  console.log(`GET ${sampleUrl}`);
  console.log(`  ok=${sample.ok} mock=${sample.mock} total=${sample.total}`);
  if (sample.items?.[0]) {
    const a = sample.items[0];
    console.log(`  首张: #${a.cardId} ${a.symbol} mode=${a.mode} maxProfit=${a.maxProfitPct}%`);
  }

  console.log("\n=== 2) 启动模拟验证任务 POST ===");
  const startUrl = `${BASE}${api("/cards/validate")}`;
  const startRes = await fetch(startUrl, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ mock: true, mockCount: 6 }),
  });
  const started = await startRes.json();
  if (!started.ok) {
    console.error("启动失败:", started);
    process.exit(1);
  }
  const jobId = started.jobId;
  console.log(`POST ${startUrl}`);
  console.log(`  jobId=${jobId} status=${started.status}`);

  if (useWs) {
    console.log("\n=== 3) WebSocket 监听 ===");
    const wsUrl = BASE.replace(/^http/, "ws") + "/ws";
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WS 超时 30s"));
      }, 30_000);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.channel !== "meta" || !String(msg.kind ?? "").startsWith("card_validate")) return;
          if (msg.jobId && msg.jobId !== jobId) return;
          if (msg.kind === "card_validate_progress") {
            console.log(`  [${msg.index}/${msg.total}] ${msg.symbol} #${msg.cardId}`);
          } else if (msg.kind === "card_validate_item") {
            const it = msg.item ?? {};
            const line =
              it.mode === "current"
                ? `currentPnl=${it.currentPnlPct}%`
                : `maxProfit=${it.maxProfitPct}% maxDD=${it.maxDrawdownPct}%`;
            console.log(`  item #${it.cardId} ${it.symbol} ${line}`);
          } else if (msg.kind === "card_validate_done") {
            console.log(`  done items=${msg.items?.length ?? 0} errors=${msg.errors?.length ?? 0}`);
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          } else if (msg.kind === "card_validate_error") {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.error ?? "validate error"));
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => reject(new Error("WebSocket 连接失败"));
    });
  } else {
    console.log("\n=== 3) 轮询直到完成 ===");
    const pollUrl = `${BASE}${api(`/cards/validate/${jobId}`)}`;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const pollRes = await fetch(pollUrl, { headers: headers() });
      const st = await pollRes.json();
      if (st.current) {
        console.log(`  [${st.current.index}/${st.current.total}] ${st.current.symbol}`);
      }
      if (st.status === "done" || st.status === "error") {
        console.log(`  status=${st.status} items=${st.items?.length ?? 0}`);
        if (st.items?.length) {
          for (const it of st.items) {
            const line =
              it.mode === "current"
                ? `currentPnl=${it.currentPnlPct}%`
                : `maxProfit=${it.maxProfitPct}% maxDD=${it.maxDrawdownPct}%`;
            console.log(`    #${it.cardId} ${it.symbol} ${line}`);
          }
        }
        break;
      }
    }
  }

  console.log("\n完成。加 --ws 可测 WebSocket 推送。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
