import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import AppErrorBoundary from "./components/common/AppErrorBoundary";
import "./index.css";

import "./i18n";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Last line of defence. App.tsx already guards the routes; this catches
        anything that escapes above that — including a failure in the shell
        itself — so the user always gets the recovery panel instead of a blank
        page. */}
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
