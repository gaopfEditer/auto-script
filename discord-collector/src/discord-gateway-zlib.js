/**
 * Discord Gateway compress=zlib-stream：按 WebSocket 连接维护 zlib  inflater。
 */
import zlib from "node:zlib";

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

export function createDiscordGatewayZlibHub() {
  /** @type {Map<string, { inflate: zlib.Inflate, pending: string }>} */
  const sessions = new Map();

  /**
   * @param {string} requestId
   * @param {Buffer} buf
   * @returns {Promise<unknown[]>}
   */
  function feed(requestId, buf) {
    const rid = String(requestId ?? "").trim();
    if (!rid || !buf?.length) return Promise.resolve([]);

    let session = sessions.get(rid);
    if (!session) {
      const inflate = zlib.createInflate();
      inflate.setMaxListeners(20);
      session = { inflate, pending: "" };
      sessions.set(rid, session);
    }

    return new Promise((resolve, reject) => {
      /** @type {unknown[]} */
      const collected = [];

      /** @param {Buffer} chunk */
      const onData = (chunk) => {
        session.pending += chunk.toString("utf8");
        const { objects, rest } = drainGatewayJsonObjects(session.pending);
        session.pending = rest;
        collected.push(...objects);
      };

      const onError = (err) => {
        session.inflate.removeListener("data", onData);
        session.inflate.removeListener("error", onError);
        reject(err);
      };

      session.inflate.once("error", onError);
      session.inflate.on("data", onData);

      session.inflate.write(buf, (writeErr) => {
        session.inflate.removeListener("data", onData);
        session.inflate.removeListener("error", onError);
        if (writeErr) reject(writeErr);
        else resolve(collected);
      });
    });
  }

  /** @param {string} requestId */
  function remove(requestId) {
    const rid = String(requestId ?? "").trim();
    const session = sessions.get(rid);
    if (!session) return;
    try {
      session.inflate.close();
    } catch {
      /* ignore */
    }
    sessions.delete(rid);
  }

  /** @param {string} requestId */
  function hasSession(requestId) {
    return sessions.has(String(requestId ?? "").trim());
  }

  return { feed, remove, hasSession };
}
