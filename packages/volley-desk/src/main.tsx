import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DeskStoreProvider } from "./store/context";
import "./styles/desk.css";
import "./styles/responsive.css";

const root = document.getElementById("root");
if (!root) throw new Error("volley-desk: #root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <DeskStoreProvider>
      <App />
    </DeskStoreProvider>
  </StrictMode>,
);
