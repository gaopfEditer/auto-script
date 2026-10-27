import { NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/train?new=1", label: "新一局", end: false },
  { to: "/train/settings", label: "设置", end: true },
  { to: "/train/stats", label: "统计", end: true },
] as const;

export function TrainShell() {
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
        <NavLink to="/" className="train-back-radar">
          返回雷达
        </NavLink>
      </header>
      <main className="train-main">
        <Outlet />
      </main>
    </div>
  );
}
