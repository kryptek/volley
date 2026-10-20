import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SignInGate } from "./auth/SignInGate";
import "./styles/desk.css";
import "./styles/responsive.css";

const root = document.getElementById("root");
if (!root) throw new Error("volley-desk: #root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <SignInGate>
      <App />
    </SignInGate>
  </StrictMode>,
);
