/**
 * 立即跑一轮评估待结算：node src/card-eval-pending-settle-cli.js [--scheduled]
 * 默认 force=全量未决；--scheduled 仅 16h+ 常规口径。
 */
import "./load-env.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { tryOpenStore } from "./store.js";
import { runEvalPendingSettleSweep } from "./card-eval-pending-settle.js";

const log = createLogger("card-eval-settle");
const scheduled = process.argv.includes("--scheduled");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 2000;

async function main() {
  const { store, offline } = await tryOpenStore(config.mysql, log);
  if (offline) {
    console.error("MySQL 不可用，无法结算");
    process.exit(1);
  }
  /** @type {import("./card-eval-pending-settle.js").runEvalPendingSettleSweep extends (a: unknown, b: unknown, c?: infer O) => Promise<infer R> ? R : never} */
  let summary = { ok: false, settled: 0, closed: 0, failed: 0, skipped: 0, items: [] };
  const maxRounds = scheduled ? 1 : 4;
  for (let round = 1; round <= maxRounds; round += 1) {
    summary = await runEvalPendingSettleSweep(store, log, {
      force: !scheduled,
      nearMarketEntryPct: config.cardEvalNearMarketEntryPct,
      limit,
    });
    const touched = (summary.settled || 0) + (summary.closed || 0);
    log.info(
      `评估结算第 ${round} 轮: settled=${summary.settled} closed=${summary.closed} failed=${summary.failed} skipped=${summary.skipped}`
    );
    if (!summary.ok || touched === 0 || (summary.failed || 0) > 0) break;
  }
  console.log(JSON.stringify(summary, null, 2));
  await store.close?.();
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
