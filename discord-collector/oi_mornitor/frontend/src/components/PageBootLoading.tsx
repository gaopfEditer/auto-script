import { memo } from "react";

type Props = {
  message?: string;
  hint?: string;
  /** 仅覆盖内容区，保留顶栏 */
  inset?: boolean;
};

export const PageBootLoading = memo(function PageBootLoading({
  message = "加载中…",
  hint = "首次打开需连接雷达并拉取数据，可能需几秒",
  inset = true,
}: Props) {
  return (
    <div
      className={`page-boot-loading${inset ? " page-boot-loading-inset" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="page-boot-loading-spinner" aria-hidden="true" />
      <p className="page-boot-loading-msg">{message}</p>
      {hint ? <p className="page-boot-loading-hint">{hint}</p> : null}
    </div>
  );
});
