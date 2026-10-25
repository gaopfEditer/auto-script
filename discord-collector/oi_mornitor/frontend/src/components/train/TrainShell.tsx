import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { confirmLeaveRunningTrain } from "../../train/confirmLeave";

const NAV = [
  { to: "/train?new=1", label: "新一局", end: false },
  { to: "/train/settings", label: "设置", end: true },
  { to: "/train/stats", label: "统计", end: true },
] as const;

export function TrainShell() {
  const nav = useNavigate();

  const leaveToRadar = () => {
    if (!confirmLeaveRunningTrain()) return;
    nav("/");
  };

  return (
    <div className="mercu-app train-app">
      <header className="train-topbar">
        <div className="train-topbar-left">
          <span className="train-logo">盲K训练</span>
          <nav className="train-nav">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => (isActive ? "active" : undefined)}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <button type="button" className="train-back-radar" onClick={leaveToRadar}>
          返回雷达
        </button>
      </header>
      <main className="train-main">
        <Outlet />
      </main>
    </div>
  );
}
