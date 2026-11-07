/** main.tsx: renderer entry. Builds the API client from the preload bridge and mounts the app. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={createApiClient(window.anneal)} bridge={window.anneal} />
  </StrictMode>,
);
