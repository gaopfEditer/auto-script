/**
 * 图文内容板 API（经 collect:ui 反代到 Python content_board）
 */

/**
 * @typedef {{
 *   id: number,
 *   title: string,
 *   body: string,
 *   created_at: number,
 *   updated_at: number,
 *   images: Array<{ id: number, filename: string, url: string, original_name?: string }>
 * }} ContentPost
 */

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function req(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/** @returns {Promise<{ items: ContentPost[], total: number }>} */
export async function listContentPosts(limit = 50, offset = 0) {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const data = await req(`/api/content/posts?${q}`);
  return { items: data.items || [], total: data.total || 0 };
}

/** @param {number} id */
export async function getContentPost(id) {
  const data = await req(`/api/content/posts/${id}`);
  return /** @type {ContentPost} */ (data.post);
}

/**
 * @param {{ title: string, body: string, files?: File[] }} payload
 */
export async function createContentPost(payload) {
  const files = payload.files?.filter(Boolean) || [];
  if (files.length) {
    const fd = new FormData();
    fd.set("title", payload.title || "");
    fd.set("body", payload.body || "");
    for (const f of files) fd.append("images", f);
    const data = await req("/api/content/posts", { method: "POST", body: fd });
    return /** @type {ContentPost} */ (data.post);
  }
  const data = await req("/api/content/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: payload.title || "", body: payload.body || "" }),
  });
  return /** @type {ContentPost} */ (data.post);
}

/**
 * @param {number} id
 * @param {{ title?: string, body?: string }} patch
 */
export async function updateContentPost(id, patch) {
  const data = await req(`/api/content/posts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return /** @type {ContentPost} */ (data.post);
}

/** @param {number} id */
export async function deleteContentPost(id) {
  await req(`/api/content/posts/${id}`, { method: "DELETE" });
}

/**
 * @param {number} postId
 * @param {File} file
 */
export async function uploadContentImage(postId, file) {
  const fd = new FormData();
  fd.append("image", file);
  const data = await req(`/api/content/posts/${postId}/images`, { method: "POST", body: fd });
  return data;
}

/** @param {number} imageId */
export async function deleteContentImage(imageId) {
  await req(`/api/content/images/${imageId}`, { method: "DELETE" });
}

/**
 * 对外可访问的站点根（部署域名）。
 * 本机 localhost 拷贝时可用此覆盖，避免手机拿到 localhost 链接。
 * 例：VITE_CONTENT_PUBLIC_ORIGIN=https://your.domain.com
 */
function publicOrigin() {
  const configured = String(import.meta.env.VITE_CONTENT_PUBLIC_ORIGIN || "")
    .trim()
    .replace(/\/$/, "");
  if (typeof location === "undefined") return configured || "";
  const host = location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "0.0.0.0";
  if (isLocal && configured) return configured;
  return location.origin;
}

/** @param {string} url */
export function absoluteContentUrl(url) {
  const origin = publicOrigin();
  try {
    if (/^https?:\/\//i.test(url)) {
      // 已是绝对地址：本机 origin 时改写为公网域名
      const u = new URL(url);
      const local =
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        u.hostname === "[::1]";
      if (local && origin && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(origin)) {
        return new URL(u.pathname + u.search + u.hash, origin).href;
      }
      return u.href;
    }
    if (!origin) return url;
    return new URL(url, origin).href;
  } catch {
    return url;
  }
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {ContentPost} post */
export function formatPostCopyText(post) {
  const title = (post.title || "").trim();
  const body = (post.body || "").trim();
  const parts = [];
  if (title) parts.push(title);
  if (body) parts.push(body);
  if (post.images?.length) {
    parts.push("");
    parts.push(
      ...post.images.map((img, i) => `[图${i + 1}] ${absoluteContentUrl(img.url)}`),
    );
  }
  return parts.join("\n").trim();
}

/** 富文本：粘贴到备忘录/文档等可直接出图；微信等多数只吃纯文本 */
/** @param {ContentPost} post */
export function formatPostCopyHtml(post) {
  const title = (post.title || "").trim();
  const body = (post.body || "").trim();
  const chunks = [];
  if (title) chunks.push(`<div><strong>${escapeHtml(title)}</strong></div>`);
  if (body) {
    chunks.push(
      `<div>${escapeHtml(body).replace(/\r\n/g, "\n").replace(/\n/g, "<br>")}</div>`,
    );
  }
  for (const img of post.images || []) {
    const src = absoluteContentUrl(img.url);
    chunks.push(
      `<div style="margin:8px 0"><img src="${escapeHtml(src)}" alt="" style="max-width:100%;height:auto" /></div>`,
    );
  }
  return `<div>${chunks.join("")}</div>`;
}

/**
 * @param {ContentPost} post
 * @returns {Promise<"rich" | "text">}
 */
export async function copyPostToClipboard(post) {
  const text = formatPostCopyText(post);
  const html = formatPostCopyHtml(post);

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      /** @type {Record<string, Blob>} */
      const payload = {
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      };
      // 单图时附带图片二进制，部分 App 粘贴可直接出图
      if (post.images?.length === 1) {
        try {
          const res = await fetch(absoluteContentUrl(post.images[0].url));
          const blob = await res.blob();
          if (blob.type.startsWith("image/")) {
            const type = blob.type === "image/png" || blob.type === "image/jpeg" ? blob.type : "image/png";
            payload[type] = blob.type === type ? blob : new Blob([blob], { type });
          }
        } catch {
          /* 忽略，仍复制图文 */
        }
      }
      await navigator.clipboard.write([new ClipboardItem(payload)]);
      return "rich";
    } catch {
      /* fall through */
    }
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return "text";
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return "text";
}

/**
 * 把单张图以图片二进制写入剪贴板（支持的 App 粘贴可显示图片）
 * @param {string} url
 */
export async function copyImageAsBlob(url) {
  const abs = absoluteContentUrl(url);
  const res = await fetch(abs);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("不是图片");
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    await navigator.clipboard.writeText(abs);
    return "url";
  }
  const type = blob.type === "image/png" || blob.type === "image/jpeg" ? blob.type : "image/png";
  const out = blob.type === type ? blob : new Blob([await blob.arrayBuffer()], { type });
  try {
    await navigator.clipboard.write([new ClipboardItem({ [type]: out })]);
    return "image";
  } catch {
    await navigator.clipboard.writeText(abs);
    return "url";
  }
}

/**
 * 系统分享（手机端最稳：可把图文发给微信等）
 * @param {ContentPost} post
 * @returns {Promise<"shared" | "unsupported" | "cancelled">}
 */
export async function sharePostNative(post) {
  const text = formatPostCopyText(post);
  /** @type {File[]} */
  const files = [];
  for (let i = 0; i < (post.images || []).length; i++) {
    try {
      const img = post.images[i];
      const res = await fetch(absoluteContentUrl(img.url));
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
      files.push(new File([blob], `img${i + 1}.${ext}`, { type: blob.type || "image/png" }));
    } catch {
      /* skip broken */
    }
  }

  if (!navigator.share) return "unsupported";
  try {
    const data = /** @type {ShareData} */ ({
      title: (post.title || "").trim() || "内容板",
      text,
    });
    if (files.length && navigator.canShare?.({ files })) {
      data.files = files;
    }
    await navigator.share(data);
    return "shared";
  } catch (e) {
    if (e && /** @type {Error} */ (e).name === "AbortError") return "cancelled";
    throw e;
  }
}
