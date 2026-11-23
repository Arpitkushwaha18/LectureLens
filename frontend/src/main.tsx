import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/index.css";
import App from "@/App";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Unable to mount LectureLens: #root element is missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
