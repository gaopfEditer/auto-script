import { chromium } from "playwright";

/**
 * 通过 connectOverCDP 附着到已启动的 Chrome，在 youtube-transcript.ai 页面上下文中 fetch 文稿。
 */
export class CdpTranscriptClient {
  /**
   * @param {{ cdpUrl: string, siteUrl: string, timeoutMs: number, log: ReturnType<import('./logger.js').createLogger> }} opts
   */
  constructor(opts) {
    this.cdpUrl = opts.cdpUrl;
    this.siteUrl = opts.siteUrl;
    this.timeoutMs = opts.timeoutMs;
    this.log = opts.log;
    /** @type {import('playwright').Browser | null} */
    this.browser = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    this.ready = false;
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }

  async connect() {
    this.log.info(`connectOverCDP → ${this.cdpUrl}`);
    this.browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 30_000 });
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error("CDP 浏览器无可用 context");

    const existing = ctx.pages().find((p) => {
      try {
        return p.url().includes("youtube-transcript.ai");
      } catch {
        return false;
      }
    });
    this.page = existing ?? (await ctx.newPage());

    if (!existing) {
      this.log.info(`打开 ${this.siteUrl}`);
      await this.page.goto(this.siteUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    } else {
      this.log.info(`复用已打开标签: ${this.page.url().slice(0, 120)}`);
    }

    this.ready = true;
    this.log.info("CDP 文稿客户端就绪");
  }

  /**
   * @param {string} videoId
   * @param {string | undefined} lang
   */
  async fetchTranscriptText(videoId, lang) {
    if (!this.page || !this.ready) throw new Error("CDP 尚未连接，请先调用 connect()");
    return this.#enqueue(() => this.#fetchOnce(videoId, lang));
  }

  /**
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  #enqueue(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * @param {string} videoId
   * @param {string | undefined} lang
   */
  async #fetchOnce(videoId, lang) {
    const page = this.page;
    if (!page) throw new Error("无可用 page");

    const path = lang
      ? `/transcript/${videoId}.txt?lang=${encodeURIComponent(lang)}`
      : `/transcript/${videoId}.txt`;
    const url = `${this.siteUrl}${path}`;
    this.log.debug(`goto ${url}`);

    try {
      const resp = await page.goto(url, { waitUntil: "commit", timeout: this.timeoutMs });
      if (!resp) throw new Error("page.goto 无响应");
      const status = resp.status();
      const text = await resp.text();
      if (status < 200 || status >= 300) {
        const hint = text ? ` — ${text.slice(0, 300)}` : "";
        throw new Error(`youtube-transcript.ai HTTP ${status}${hint}`);
      }
      if (!text.trim()) throw new Error("返回正文为空");
      return text;
    } catch (e) {
      const err = /** @type {Error} */ (e);
      if (err.message.includes("Target closed") || err.message.includes("has been closed")) {
        this.ready = false;
        throw new Error(`CDP 页面已关闭: ${err.message}`);
      }
      throw err;
    }
  }

  async close() {
    this.ready = false;
    this.page = null;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.log.info("已断开 CDP（未关闭你的 Chrome）");
    }
  }
}
