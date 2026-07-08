import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import { API_BASE } from "@/lib/api";
import App from "./App";
import "./index.css";

// Point generated API client at the correct base
if (API_BASE) {
  setBaseUrl(API_BASE);
}

createRoot(document.getElementById("root")!).render(<App />);
