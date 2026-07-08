import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Point API client at the backend server
setBaseUrl("http://localhost:5001");

createRoot(document.getElementById("root")!).render(<App />);
