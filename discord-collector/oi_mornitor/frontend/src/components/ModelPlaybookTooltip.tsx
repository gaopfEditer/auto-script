import { memo, type ReactNode } from "react";
import type { PotentialDiscoveryCatalogEntry } from "../types";

type Props = {
  catalog?: PotentialDiscoveryCatalogEntry | null;
  stage?: string;
  className?: string;
  children: ReactNode;
};

export const ModelPlaybookTooltip = memo(function ModelPlaybookTooltip({
  catalog,
  stage,
  className = "",
  children,
}: Props) {
  const hasBody =
    catalog &&
    (catalog.typical_outlook ||
      (catalog.cautions?.length ?? 0) > 0 ||
      (stage && catalog.stage_hints?.[stage]));

  if (!hasBody) {
    return <span className={className}>{children}</span>;
  }

  const stageHint =
    stage && catalog.stage_hints?.[stage] ? catalog.stage_hints[stage] : null;

  return (
    <span className={`potential-signal-tip-wrap${className ? ` ${className}` : ""}`}>
      {children}
      <span className="potential-signal-popover" role="tooltip">
        <span className="potential-signal-popover-title">{catalog.label}</span>
        {stageHint ? (
          <p className="potential-signal-popover-stage">
            <strong>当前阶段 {stage}</strong> {stageHint}
          </p>
        ) : null}
        {catalog.typical_outlook ? (
          <>
            <p className="potential-signal-popover-kicker">常见走势</p>
            <p className="potential-signal-popover-text">{catalog.typical_outlook}</p>
          </>
        ) : null}
        {(catalog.cautions?.length ?? 0) > 0 ? (
          <>
            <p className="potential-signal-popover-kicker">注意事项</p>
            <ul className="potential-signal-popover-list">
              {catalog.cautions!.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        ) : null}
        {(catalog.end_signals?.length ?? 0) > 0 ? (
          <>
            <p className="potential-signal-popover-kicker">失效征兆</p>
            <ul className="potential-signal-popover-list potential-signal-popover-end">
              {catalog.end_signals!.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        ) : null}
      </span>
    </span>
  );
});
