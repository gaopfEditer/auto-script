/**
 * 巨鲸 HTTP API → 与 DOM 相同的消息结构，供 pipeline 复用。
 */
import { config } from "./config.js";
import {
  kolvipApiFetchChannelMessages,
  kolvipApiPing,
  KolvipApiError,
} from "./kolvip-api-client.js";
import { resolveKolvipApiWtoken } from "./kolvip-api-auth.js";
import { kolvipApiRawToDomMessage } from "./kolvip-api-message.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
export async function buildKolvipApiClient(log) {
  const { wtoken, source } = await resolveKolvipApiWtoken(log);
  if (!wtoken) {
    throw new KolvipApiError(
      "未配置巨鲸 wtoken（KOLVIP_API_WTOKEN 或 data/kolvip-api-token.json；可选 KOLVIP_API_CDP_TOKEN_SYNC=1）",
      "auth"
    );
  }
  return {
    client: {
      baseUrl: config.kolvipApiBaseUrl,
      wtoken,
      timeoutMs: config.kolvipApiTimeoutMs,
    },
    tokenSource: source,
  };
}

/**
 * @param {{
 *   channels: Array<{ logicName: string, kolvipChannelId: string, discordChannelId: string }>,
 *   maxPerChannel: number,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 * }} opts
 */
export async function fetchKolvipChannelsViaApi(opts) {
  const log = opts.log;
  const { client, tokenSource } = await buildKolvipApiClient(log);
  await kolvipApiPing(client).catch(() => {});

  /** @type {Array<{ channel: typeof opts.channels[number], messages: import('./kolvip-cdp-message.js').KolvipDomMessage[], error?: string }>} */
  const results = [];
  const maxPerChannel = Math.min(150, Math.max(5, opts.maxPerChannel || 40));
  const delayMs = config.kolvipApiChannelDelayMs;

  for (let i = 0; i < opts.channels.length; i++) {
    const channel = opts.channels[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const raw = await kolvipApiFetchChannelMessages(client, channel.kolvipChannelId, {
        beforeId: 0,
        limit: maxPerChannel,
      });
      const messages = raw
        .map((r) => kolvipApiRawToDomMessage(r))
        .filter((m) => m.dataId)
        .slice(-maxPerChannel);
      log.info(
        `巨鲸 API ${channel.logicName} ch=${channel.kolvipChannelId} 可见 ${messages.length} 条 (token=${tokenSource})`
      );
      results.push({ channel, messages });
    } catch (e) {
      const error =
        e instanceof KolvipApiError ? e.message : /** @type {Error} */ (e).message;
      log.warn(`巨鲸 API 频道 ${channel.logicName} 失败: ${error}`);
      results.push({ channel, messages: [], error });
    }
  }
  return { results, tokenSource };
}
