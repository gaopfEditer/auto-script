# Token 鉴权测试后台

纯 Node（无依赖）。用来测客户端带 token 访问时的两种结果：

| 情况 | 响应 |
|------|------|
| 正确且未过期 | `访问成功` |
| 已过期 | `token 过期，请更新 token` |

## 启动

```bash
cd test
node server.js
# 或: npm start
```

默认：`http://127.0.0.1:3980`  
环境变量：`PORT`、`TOKEN_SECRET`、`TOKEN_TTL_SEC`（默认 60 秒）

## 接口

- `POST /api/token` — 签发有效 token（`{ "ttlSeconds": 5 }` 可造短过期）
- `POST /api/token/expired` — 直接签发已过期 token
- `GET /api/protected` — 受保护接口（`Authorization: Bearer <token>`）
- `POST /api/token/refresh` — 用旧/过期 token 换新

## 快速试一遍

```bash
# 1) 拿有效 token
curl -s -X POST http://127.0.0.1:3980/api/token -H "Content-Type: application/json" -d "{\"ttlSeconds\":30}"

# 2) 访问成功
curl -s http://127.0.0.1:3980/api/protected -H "Authorization: Bearer <上一步的token>"

# 3) 过期 token → 提示更新
curl -s -X POST http://127.0.0.1:3980/api/token/expired
curl -s http://127.0.0.1:3980/api/protected -H "Authorization: Bearer <过期token>"

# 4) 更新 token
curl -s -X POST http://127.0.0.1:3980/api/token/refresh -H "Content-Type: application/json" -d "{\"token\":\"<过期token>\"}"
```
