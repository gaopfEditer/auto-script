import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ensureFreshUi } from "./utils/ensureFreshUi";

void (async () => {
  if (await ensureFreshUi()) return;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
