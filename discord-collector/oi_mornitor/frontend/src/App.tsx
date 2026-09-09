import { createHashRouter, RouterProvider } from "react-router-dom";
import { RadarSSEProvider } from "./hooks/useRadarSSE";
import { RadarPage } from "./pages/RadarPage";
import { PatternMonitorPage } from "./pages/PatternMonitorPage";
import "./styles/app.css";

const router = createHashRouter(
  [
    { index: true, element: <RadarPage /> },
    { path: "patterns", element: <PatternMonitorPage /> },
  ]
);

export default function App() {
  return (
    <RadarSSEProvider>
      <RouterProvider router={router} />
    </RadarSSEProvider>
  );
}
