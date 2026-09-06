import { useState } from "react";
import {
  coinIconSourceCount,
  coinIconUrl,
  forgetCoinIconUrl,
  rememberCoinIconUrl,
  resolveCoinIconSrc,
} from "../utils/coinIcon";
import { coinInitial } from "../utils/symbol";

type Props = {
  symbol: string;
  /** 默认 coin-avatar；排行榜用 rank */
  variant?: "default" | "rank" | "bias";
  size?: "sm" | "md";
  className?: string;
};

export function CoinAvatar({
  symbol,
  variant = "default",
  size = "md",
  className = "",
}: Props) {
  const initial = resolveCoinIconSrc(symbol);
  const [sourceIndex, setSourceIndex] = useState(initial.sourceIndex);
  const [cachedSrc, setCachedSrc] = useState<string | null | undefined>(
    initial.fromCache ? initial.src : undefined,
  );
  const [seenSymbol, setSeenSymbol] = useState(symbol);

  if (seenSymbol !== symbol) {
    setSeenSymbol(symbol);
    const next = resolveCoinIconSrc(symbol);
    setSourceIndex(next.sourceIndex);
    setCachedSrc(next.fromCache ? next.src : undefined);
  }

  const fromCacheHit = typeof cachedSrc === "string";
  const exhausted = cachedSrc === null || sourceIndex >= coinIconSourceCount();
  const src = fromCacheHit
    ? cachedSrc
    : exhausted
      ? null
      : coinIconUrl(symbol, Math.max(sourceIndex, 0));

  const baseClass =
    variant === "rank" ? "rank-coin-avatar" : variant === "bias" ? "bias-avatar" : "coin-avatar";
  const classes = [
    baseClass,
    size === "sm" && variant === "default" ? "sm" : "",
    src ? "has-icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (!src) {
    return <span className={classes}>{coinInitial(symbol)}</span>;
  }

  return (
    <span className={classes}>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => rememberCoinIconUrl(symbol, src)}
        onError={() => {
          if (fromCacheHit) {
            forgetCoinIconUrl(symbol);
            setCachedSrc(undefined);
            setSourceIndex(0);
            return;
          }
          const next = sourceIndex + 1;
          if (next >= coinIconSourceCount()) {
            rememberCoinIconUrl(symbol, null);
            setCachedSrc(null);
            setSourceIndex(next);
            return;
          }
          setSourceIndex(next);
        }}
      />
    </span>
  );
}
