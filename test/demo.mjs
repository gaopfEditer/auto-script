/**
 * 完整鉴权演示：
 * 1) 先用固定 JWT 打一次 /api/protected
 * 2) 再跑：签发 → 成功 → 过期失败 → 刷新 → 再成功
 *
 * 用法：先启动 server.js，再 node demo.mjs
 */
const base = process.env.TOKEN_TEST_BASE || "http://127.0.0.1:3981";

const authToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiQ2FtYnJpZGdlLVNjcmVlbi0wMDAwMDAwMSIsImlzcyI6IkNhbUJyaWRnZSIsInN1YiI6IkNhbWJyaWRnZS1TY3JlZW4tMDAwMDAwMDEiLCJuYmYiOjE3NjQ1NzA0NTIsImlhdCI6MTc2NDU3MDQ1Mn0.yrB3NK_w2xjI8V5jAeNWDmW5I417NB2YVzimjiNxEHs";

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function dump(title, r) {
  console.log(`\n======== ${title} ========`);
  console.log("HTTP", r.status);
  console.log(JSON.stringify(r.json, null, 2));
}

console.log("BASE =", base);

// ---------- A) 先用固定 JWT 测一下 ----------
dump(
  "A) 固定 JWT 访问 /api/protected",
  await api("GET", "/api/protected", { token: authToken })
);
console.log(
  "说明：该 JWT 由 CamBridge 签发（HS256），本测试服密钥不同，通常会判无效；下一步改用本服签发的 token。"
);

// ---------- B) 本服完整流程 ----------
const issue = await api("POST", "/api/token", { body: { ttlSeconds: 120, sub: "demo" } });
dump("B1) 签发有效 token", issue);
const token = issue.json.token;
if (!token) throw new Error("签发失败：没有 token");

dump("B2) 正确 token → 访问成功", await api("GET", "/api/protected", { token }));

const exp = await api("POST", "/api/token/expired", { body: { sub: "demo" } });
dump("B3) 签发过期 token", exp);
const bad = exp.json.token;
if (!bad) throw new Error("过期签发失败：没有 token");

dump("B4) 过期 token → 应失败", await api("GET", "/api/protected", { token: bad }));

const ref = await api("POST", "/api/token/refresh", { body: { token: bad } });
dump("B5) 刷新 token", ref);
const neu = ref.json.token;
if (!neu) throw new Error("刷新失败：新 token 为空");

dump("B6) 新 token → 访问成功", await api("GET", "/api/protected", { token: neu }));

console.log("\n全部跑完。");
