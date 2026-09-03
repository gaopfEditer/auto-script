import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RadarSSEProvider } from "./hooks/useRadarSSE";
import { RadarPage } from "./pages/RadarPage";
import { PatternMonitorPage } from "./pages/PatternMonitorPage";
import "./styles/app.css";

export default function App() {
  return (
    <BrowserRouter>
      <RadarSSEProvider>
        <Routes>
          <Route path="/" element={<RadarPage />} />
          <Route path="/patterns" element={<PatternMonitorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </RadarSSEProvider>
    </BrowserRouter>
  );
}
