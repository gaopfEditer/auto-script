/**
 * 固定从 discord-collector/.env 加载（不依赖 cwd，避免误读上级目录 .env）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(_dir, "..", ".env");

dotenv.config({ path: envPath, override: true });
