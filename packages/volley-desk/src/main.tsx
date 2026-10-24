import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SignInGate } from "./auth/SignInGate";
import { applyLookToDocument } from "./look/applyLook";
import { loadLook } from "./look/useLook";
import "./styles/desk.css";
import "./styles/responsive.css";
import "./styles/lite.css";

const root = document.getElementById("root");
if (!root) throw new Error("volley-desk: #root missing from index.html");

// The theme before the first paint: no flash, and the sign-in card (before App) is themed too.
applyLookToDocument(loadLook());

createRoot(root).render(
  <StrictMode>
    <SignInGate>
      <App />
    </SignInGate>
  </StrictMode>,
);
