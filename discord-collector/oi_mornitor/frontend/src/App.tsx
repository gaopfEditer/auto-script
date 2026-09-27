import { createHashRouter, RouterProvider } from "react-router-dom";
import { TrainShell } from "./components/train/TrainShell";
import { RadarSSEProvider } from "./hooks/useRadarSSE";
import { RadarPage } from "./pages/RadarPage";
import { PatternMonitorPage } from "./pages/PatternMonitorPage";
import { BacktestPage } from "./pages/BacktestPage";
import { TrainEntryPage } from "./pages/TrainEntryPage";
import { TrainReviewPage } from "./pages/TrainReviewPage";
import { TrainSessionPage } from "./pages/TrainSessionPage";
import { TrainSettingsPage } from "./pages/TrainSettingsPage";
import { TrainStatsPage } from "./pages/TrainStatsPage";
import "./styles/app.css";

const router = createHashRouter(
  [
    { index: true, element: <RadarPage /> },
    { path: "patterns", element: <PatternMonitorPage /> },
    { path: "backtest", element: <BacktestPage /> },
    {
      path: "train",
      element: <TrainShell />,
      children: [
        { index: true, element: <TrainEntryPage /> },
        { path: "session/:id", element: <TrainSessionPage /> },
        { path: "review/:id", element: <TrainReviewPage /> },
        { path: "stats", element: <TrainStatsPage /> },
        { path: "settings", element: <TrainSettingsPage /> },
      ],
    },
  ]
);

export default function App() {
  return (
    <RadarSSEProvider>
      <RouterProvider router={router} />
    </RadarSSEProvider>
  );
}
