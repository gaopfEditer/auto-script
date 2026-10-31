import { memo, useId, useState, type ReactNode } from "react";

export type RegimeTipData = {
  id?: string;
  title?: string;
  fits?: string;
  fails?: string;
  watch?: string;
};

type Props = {
  tip?: RegimeTipData | null;
  /** fallback if tip missing */
  title?: string;
  className?: string;
  children?: ReactNode;
};

/** 行情环境 tip 图标：悬停/点击弹出 fits / fails / watch */
export const RegimeTip = memo(function RegimeTip({ tip, title, className = "", children }: Props) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  if (!tip && !children) return null;
  const label = tip?.title || title || "行情环境";
  return (
    <span
      className={`bt-regime-tip${className ? ` ${className}` : ""}${open ? " open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="bt-regime-tip-btn"
        aria-label={`${label} · 行情环境说明`}
        aria-expanded={open}
        aria-controls={uid}
        title="行情环境"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children ?? "ⓘ"}
      </button>
      {tip ? (
        <span className="bt-regime-popover" id={uid} role="tooltip">
          <span className="bt-regime-popover-title">{label}</span>
          {tip.fits ? (
            <>
              <span className="bt-regime-kicker">适合</span>
              <p className="bt-regime-text">{tip.fits}</p>
            </>
          ) : null}
          {tip.fails ? (
            <>
              <span className="bt-regime-kicker">失效</span>
              <p className="bt-regime-text">{tip.fails}</p>
            </>
          ) : null}
          {tip.watch ? (
            <>
              <span className="bt-regime-kicker">观察</span>
              <p className="bt-regime-text">{tip.watch}</p>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
});
