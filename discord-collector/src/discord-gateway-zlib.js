/**
 * Discord Gateway compress=zlib-stream：按 WebSocket 连接维护 zlib inflater。
 *
 * Node 26：非法 zlib 帧只会触发 Inflate 'error'（write 回调不一定会走），
 * 且必须始终挂有 error 监听，否则变成进程级未捕获异常。
 */
import zlib from "node:zlib";

/** 不完整 JSON 挂起缓冲上限（防损坏流把 pending 撑到 GB） */
const MAX_PENDING_CHARS = 2_000_000;
/** 同时保留的 inflater 会话上限 */
const MAX_SESSIONS = 32;

/** @param {string} url */
export function isDiscordGatewayZlibStreamUrl(url) {
  const u = String(url ?? "").toLowerCase();
  return u.includes("gateway.discord.gg") && u.includes("compress=zlib-stream");
}

/** @param {string} url */
export function isDiscordGatewayUrl(url) {
  const u = String(url ?? "").toLowerCase();
  return u.includes("gateway.discord.gg") || (u.includes("gateway") && u.includes("encoding=json"));
}

/**
 * 从文本缓冲中尽可能解析完整 JSON 对象。
 * @param {string} text
 */
export function drainGatewayJsonObjects(text) {
  /** @type {unknown[]} */
  const objects = [];
  let s = String(text ?? "");
  while (s.length) {
    s = s.trimStart();
    if (!s.startsWith("{")) {
      const i = s.indexOf("{");
      if (i < 0) return { objects, rest: "" };
      s = s.slice(i);
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) return { objects, rest: s };
    try {
      objects.push(JSON.parse(s.slice(0, end)));
      s = s.slice(end);
    } catch {
      return { objects, rest: s };
    }
  }
  return { objects, rest: "" };
}

/**
 * @typedef {{
 *   inflate: import('node:zlib').Inflate,
 *   pending: string,
 *   dead: boolean,
 *   onFail: ((err: Error) => void) | null,
 * }} ZlibSession
 */

export function createDiscordGatewayZlibHub() {
  /** @type {Map<string, ZlibSession>} */
  const sessions = new Map();
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();

  /** @param {import('node:zlib').Inflate} inflate */
  function safeClose(inflate) {
    try {
      inflate.removeAllListeners("data");
      inflate.removeAllListeners("error");
      inflate.on("error", () => {});
      try {
        inflate.close();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  /** @param {string} rid */
  function destroySession(rid) {
    const session = sessions.get(rid);
    if (!session) return;
    session.dead = true;
    session.onFail = null;
    sessions.delete(rid);
    safeClose(session.inflate);
  }

  /** @param {string} rid */
  function evictIfNeeded(rid) {
    if (sessions.has(rid) || sessions.size < MAX_SESSIONS) return;
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) destroySession(oldest);
  }

  /** @param {string} rid */
  function ensureSession(rid) {
    let session = sessions.get(rid);
    if (session && !session.dead) return session;
    if (session?.dead) sessions.delete(rid);
    evictIfNeeded(rid);

    const inflate = zlib.createInflate();
    inflate.setMaxListeners(20);
    /** @type {ZlibSession} */
    session = { inflate, pending: "", dead: false, onFail: null };

    inflate.on("error", (err) => {
      session.dead = true;
      const fail = session.onFail;
      session.onFail = null;
      // 不在这里 close；交给 feed 结算后的 microtask，避免二次异常
      if (fail) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    sessions.set(rid, session);
    return session;
  }

  /**
   * @param {string} rid
   * @param {Buffer} buf
   * @returns {Promise<unknown[]>}
   */
  function feedUnlocked(rid, buf) {
    const session = ensureSession(rid);
    if (session.dead) {
      destroySession(rid);
      return Promise.reject(
        Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR" })
      );
    }

    return new Promise((resolve, reject) => {
      /** @type {unknown[]} */
      const collected = [];
      let settled = false;

      /** @param {Error} err */
      const finishErr = (err) => {
        if (settled) return;
        settled = true;
        session.onFail = null;
        try {
          session.inflate.removeListener("data", onData);
        } catch {
          /* ignore */
        }
        queueMicrotask(() => destroySession(rid));
        reject(err);
      };

      /** @param {Buffer} chunk */
      const onData = (chunk) => {
        if (settled || session.dead) return;
        session.pending += chunk.toString("utf8");
        if (session.pending.length > MAX_PENDING_CHARS) {
          finishErr(new Error(`zlib pending overflow (>${MAX_PENDING_CHARS} chars)`));
          return;
        }
        const { objects, rest } = drainGatewayJsonObjects(session.pending);
        session.pending = rest;
        collected.push(...objects);
      };

      session.onFail = finishErr;
      session.inflate.on("data", onData);

      try {
        // Node 26：出错时往往只有 'error' 事件、write 回调不调用，故结算以 onFail 为准
        session.inflate.write(buf);
        // 给同步 error 一个机会；若已 dead/settled 则不再 flush
        if (settled || session.dead) return;
        session.inflate.flush(zlib.constants.Z_SYNC_FLUSH, (flushErr) => {
          if (settled) return;
          if (flushErr || session.dead) {
            finishErr(
              flushErr instanceof Error
                ? flushErr
                : Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR" })
            );
            return;
          }
          settled = true;
          session.onFail = null;
          try {
            session.inflate.removeListener("data", onData);
          } catch {
            /* ignore */
          }
          resolve(collected);
        });
      } catch (e) {
        finishErr(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * @param {string} requestId
   * @param {Buffer} buf
   * @returns {Promise<unknown[]>}
   */
  function feed(requestId, buf) {
    const rid = String(requestId ?? "").trim();
    if (!rid || !buf?.length) return Promise.resolve([]);

    /** 独立结果 Promise，避免「then 返回的内部 promise」在 Node 26 上出现双份 rejection */
    /** @type {(v: unknown[]) => void} */
    let resolveResult;
    /** @type {(e: Error) => void} */
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const prev = tails.get(rid) ?? Promise.resolve();
    const nextTail = prev.catch(() => {}).then(async () => {
      try {
        resolveResult(await feedUnlocked(rid, buf));
      } catch (e) {
        rejectResult(e instanceof Error ? e : new Error(String(e)));
      }
    });
    // 队列链自身永不把 rejection 冒到进程
    tails.set(
      rid,
      nextTail.then(
        () => {},
        () => {}
      )
    );

    return result;
  }

  /** @param {string} requestId */
  function remove(requestId) {
    const rid = String(requestId ?? "").trim();
    destroySession(rid);
    tails.delete(rid);
  }

  /** @param {string} requestId */
  function hasSession(requestId) {
    const s = sessions.get(String(requestId ?? "").trim());
    return Boolean(s && !s.dead);
  }

  function clear() {
    for (const rid of [...sessions.keys()]) destroySession(rid);
    tails.clear();
  }

  return { feed, remove, hasSession, clear };
}
