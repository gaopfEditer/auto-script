/**
 * 扫描配置目录 *.txt → Ollama 解析 → 写入本地 JSON（同名已存在则跳过）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parsePasteTextToResult, splitPasteText } from "./youtube-paste-parse.js";

/** @typedef {{ running: boolean, currentFile: string | null, lastFinishedAt: string | null, lastStats: Record<string, number> | null }} ScanState */

/** @type {ScanState} */
const scanState = {
  running: false,
  currentFile: null,
  lastFinishedAt: null,
  lastStats: null,
};

/** @param {string} txtName */
function outputJsonName(txtName) {
  const base = path.basename(txtName);
  if (!base.toLowerCase().endsWith(".txt")) return `${base}.json`;
  return `${base.slice(0, -4)}.json`;
}

/**
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} txtName
 */
export function outputPathForTxt(inputDir, outputDir, txtName) {
  return path.join(outputDir, outputJsonName(txtName));
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listTxtFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} txtName
 */
async function outputExists(inputDir, outputDir, txtName) {
  try {
    await fs.access(outputPathForTxt(inputDir, outputDir, txtName));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ inputDir: string, outputDir: string, txtName: string, log: ReturnType<typeof import('./logger.js').createLogger>, force?: boolean }} opts
 */
export async function parseTxtFileAndSave({ inputDir, outputDir, txtName, log, force = false }) {
  const srcPath = path.join(inputDir, txtName);
  const outPath = outputPathForTxt(inputDir, outputDir, txtName);

  if (!force && (await outputExists(inputDir, outputDir, txtName))) {
    return { ok: true, skipped: true, txtName, outPath };
  }

  const raw = await fs.readFile(srcPath, "utf8");
  const { title, content } = splitPasteText(raw);
  if (!title || !content) {
    throw new Error(`${txtName}: 第一行标题或正文为空`);
  }

  const result = await parsePasteTextToResult({ title, content, log });
  const stat = await fs.stat(srcPath);

  const payload = {
    sourceFile: txtName,
    sourcePath: srcPath,
    sourceMtimeMs: stat.mtimeMs,
    parsedAt: new Date().toISOString(),
    ...result,
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  log.info(`paste-batch: 已解析 ${txtName} → ${path.basename(outPath)}`);

  return {
    ok: true,
    skipped: false,
    txtName,
    outPath,
    title: result.title,
    content: result.content,
    coinActions: result.coinActions,
    preview: result.preview,
  };
}

/**
 * @param {{
 *   inputDir: string,
 *   outputDir: string,
 *   log: ReturnType<typeof import('./logger.js').createLogger>,
 *   force?: boolean,
 *   archiveService?: ReturnType<typeof import('./card-archive-service.js').createCardArchiveService>,
 * }} opts
 */
export async function scanAndParseTxtFiles({
  inputDir,
  outputDir,
  log,
  force = false,
  archiveService,
}) {
  if (scanState.running) {
    return { ok: false, error: "扫描正在进行中", state: { ...scanState } };
  }

  scanState.running = true;
  scanState.currentFile = null;
  const stats = { total: 0, parsed: 0, skipped: 0, failed: 0 };

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(inputDir, { recursive: true }).catch(() => {});
    const files = await listTxtFiles(inputDir);
    stats.total = files.length;

    for (const txtName of files) {
      scanState.currentFile = txtName;
      try {
        const row = await parseTxtFileAndSave({ inputDir, outputDir, txtName, log, force });
        if (row.skipped) stats.skipped += 1;
        else {
          stats.parsed += 1;
          if (row.coinActions?.length) {
            await syncCoinActionWatches(archiveService, txtName, row, log);
          }
        }
      } catch (e) {
        stats.failed += 1;
        log.warn(`paste-batch: ${txtName} 失败: ${/** @type {Error} */ (e).message}`);
      }
    }

    scanState.lastStats = stats;
    scanState.lastFinishedAt = new Date().toISOString();
    return { ok: true, stats, state: { ...scanState, currentFile: null } };
  } finally {
    scanState.running = false;
    scanState.currentFile = null;
  }
}

/**
 * @param {{ inputDir: string, outputDir: string }} dirs
 */
export async function listPasteFileItems({ inputDir, outputDir }) {
  const files = await listTxtFiles(inputDir);
  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const name of files) {
    const outPath = outputPathForTxt(inputDir, outputDir, name);
    const srcPath = path.join(inputDir, name);
    let srcStat = null;
    try {
      srcStat = await fs.stat(srcPath);
    } catch {
      /* ignore */
    }

    /** @type {Record<string, unknown>} */
    let saved = null;
    try {
      const raw = await fs.readFile(outPath, "utf8");
      saved = JSON.parse(raw);
    } catch {
      /* no output yet */
    }

    const isParsing = scanState.running && scanState.currentFile === name;
    let status = "pending";
    if (isParsing) status = "parsing";
    else if (saved) status = "done";

    items.push({
      name,
      status,
      title: saved?.title ?? saved?.preview?.title ?? null,
      coinActionCount: Array.isArray(saved?.coinActions) ? saved.coinActions.length : 0,
      parsedAt: saved?.parsedAt ?? null,
      hasOutput: Boolean(saved),
      sourceMtimeMs: srcStat?.mtimeMs ?? null,
    });
  }

  items.sort((a, b) => {
    const tb = Number(b.sourceMtimeMs) || 0;
    const ta = Number(a.sourceMtimeMs) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.name).localeCompare(String(b.name), "zh");
  });

  return items;
}

/**
 * @param {ReturnType<typeof import('./card-archive-service.js').createCardArchiveService>} [archiveService]
 * @param {string} txtName
 * @param {{ title?: string, content?: string, coinActions?: unknown[] }} result
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
async function syncCoinActionWatches(archiveService, txtName, result, log) {
  if (!archiveService?.registerCoinActionWatches) return null;
  const list = Array.isArray(result.coinActions) ? result.coinActions : [];
  if (!list.length) return { registered: 0, skipped: 0, cards: [] };
  try {
    const sync = await archiveService.registerCoinActionWatches({
      sourceRef: txtName,
      title: result.title,
      coinActions: /** @type {Array<Record<string, unknown>>} */ (list),
    });
    return sync;
  } catch (e) {
    log.warn(`coin-action watch ${txtName}: ${/** @type {Error} */ (e).message}`);
    return null;
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ pasteParseInputDir: string, pasteParseOutputDir: string }} config
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 * @param {{ archiveService?: ReturnType<typeof import('./card-archive-service.js').createCardArchiveService> }} [opts]
 */
export function registerYoutubePasteBatchRoutes(app, config, log, opts = {}) {
  const archiveService = opts.archiveService;
  const dirs = () => ({
    inputDir: config.pasteParseInputDir,
    outputDir: config.pasteParseOutputDir,
  });

  app.get("/api/youtube-fetch/paste-files", async (_req, res) => {
    try {
      const { inputDir, outputDir } = dirs();
      const items = await listPasteFileItems({ inputDir, outputDir });
      res.json({
        ok: true,
        inputDir,
        outputDir,
        scan: { ...scanState },
        items,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/youtube-fetch/paste-files/:name", async (req, res) => {
    try {
      const name = path.basename(String(req.params.name ?? ""));
      if (!name.toLowerCase().endsWith(".txt")) {
        res.status(400).json({ ok: false, error: "无效文件名" });
        return;
      }
      const { inputDir, outputDir } = dirs();
      const outPath = outputPathForTxt(inputDir, outputDir, name);
      const raw = await fs.readFile(outPath, "utf8");
      res.json({ ok: true, data: JSON.parse(raw) });
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ENOENT") {
        res.status(404).json({ ok: false, error: "尚未生成解析结果" });
        return;
      }
      res.status(500).json({ ok: false, error: String(err.message ?? e) });
    }
  });

  /** 原文 .txt 全文（不依赖是否已解析） */
  app.get("/api/youtube-fetch/paste-files/:name/raw", async (req, res) => {
    try {
      const name = path.basename(String(req.params.name ?? ""));
      if (!name.toLowerCase().endsWith(".txt")) {
        res.status(400).json({ ok: false, error: "无效文件名" });
        return;
      }
      const { inputDir } = dirs();
      const srcPath = path.join(inputDir, name);
      const text = await fs.readFile(srcPath, "utf8");
      res.json({ ok: true, name, text });
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ENOENT") {
        res.status(404).json({ ok: false, error: "源文件不存在" });
        return;
      }
      res.status(500).json({ ok: false, error: String(err.message ?? e) });
    }
  });

  app.post("/api/youtube-fetch/paste-files/scan", async (req, res) => {
    try {
      if (scanState.running) {
        res.json({ ok: true, started: false, message: "扫描已在进行", scan: { ...scanState } });
        return;
      }
      const force = Boolean(req.body?.force);
      const { inputDir, outputDir } = dirs();
      void scanAndParseTxtFiles({ inputDir, outputDir, log, force, archiveService }).catch((e) => {
        log.warn(`paste-batch scan: ${/** @type {Error} */ (e).message}`);
      });
      res.json({ ok: true, started: true, scan: { ...scanState } });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/youtube-fetch/paste-files/:name/parse", async (req, res) => {
    try {
      const name = path.basename(String(req.params.name ?? ""));
      if (!name.toLowerCase().endsWith(".txt")) {
        res.status(400).json({ ok: false, error: "无效文件名" });
        return;
      }
      const force = req.body?.force !== false;
      const { inputDir, outputDir } = dirs();
      const row = await parseTxtFileAndSave({ inputDir, outputDir, txtName: name, log, force });
      /** @type {Record<string, unknown> | null} */
      let sync = null;
      if (!row.skipped && row.coinActions?.length) {
        sync = await syncCoinActionWatches(archiveService, name, row, log);
      }
      res.json({
        ok: true,
        ...row,
        sync: sync
          ? {
              registered: sync.registered ?? sync.cards?.length ?? 0,
              skipped: sync.skipped ?? 0,
              skippedItems: sync.skippedItems ?? [],
            }
          : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}

/**
 * 启动后延时全量扫描，并持续轮询输入目录：发现尚无 JSON 的新 .txt 自动解析。
 * @param {{
 *   pasteParseInputDir: string,
 *   pasteParseOutputDir: string,
 *   pasteParseStartupDelayMs: number,
 *   pasteParseWatchIntervalMs?: number,
 * }} config
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 * @param {{ archiveService?: ReturnType<typeof import('./card-archive-service.js').createCardArchiveService> }} [opts]
 */
export function startPasteBatchService(config, log, opts = {}) {
  const archiveService = opts.archiveService;
  const inputDir = config.pasteParseInputDir;
  const outputDir = config.pasteParseOutputDir;
  const delay = Math.max(0, Number(config.pasteParseStartupDelayMs) || 15_000);
  const watchMs = Math.max(60_000, Number(config.pasteParseWatchIntervalMs) || 600_000);

  /** @param {string} reason */
  async function runScan(reason) {
    if (scanState.running) return;
    try {
      const r = await scanAndParseTxtFiles({
        inputDir,
        outputDir,
        log,
        archiveService,
      });
      if (!r.ok) return;
      const s = r.stats;
      if (!s) return;
      if (s.parsed > 0 || s.failed > 0 || reason === "startup") {
        log.info(
          `paste-batch[${reason}]: 共 ${s.total} · 新解析 ${s.parsed} · 跳过 ${s.skipped} · 失败 ${s.failed}`
        );
      }
    } catch (e) {
      log.warn(`paste-batch[${reason}]: ${/** @type {Error} */ (e).message}`);
    }
  }

  log.info(
    `paste-batch: ${Math.round(delay / 1000)}s 后首次扫描，之后每 ${Math.round(watchMs / 1000)}s 探测新文件 · ${inputDir} → ${outputDir}`
  );

  setTimeout(() => {
    void runScan("startup");
  }, delay);

  setInterval(() => {
    void runScan("watch");
  }, watchMs);

  // 目录事件：落盘完成后再扫（debounce），与轮询互补
  let watchTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  void fs
    .mkdir(inputDir, { recursive: true })
    .then(async () => {
      const { watch } = await import("node:fs");
      try {
        watch(inputDir, { persistent: true }, (eventType, filename) => {
          const name = String(filename || "");
          if (name && !name.toLowerCase().endsWith(".txt")) return;
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => {
            watchTimer = null;
            void runScan(`fs:${eventType || "change"}`);
          }, 1500);
        });
        log.info(`paste-batch: 已监听目录变更 ${inputDir}`);
      } catch (e) {
        log.warn(
          `paste-batch: fs.watch 不可用（仍靠轮询）: ${/** @type {Error} */ (e).message}`
        );
      }
    })
    .catch((e) => {
      log.warn(`paste-batch: 无法创建输入目录 ${inputDir}: ${/** @type {Error} */ (e).message}`);
    });
}
