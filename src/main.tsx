import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installLinkHandler } from "./links";
import "./styles.css";

installLinkHandler();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
