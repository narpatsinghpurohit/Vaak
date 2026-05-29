import React from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "./features/settings/settings";
import { History } from "./features/history/history";
import { Transcribe } from "./features/transcribe/transcribe";
import "./styles/global.css";
import "./styles/settings.css";
import "./styles/history.css";
import "./styles/transcribe.css";

// Determine which view to show based on URL hash
// Main process loads: index.html#settings, #history, or #transcribe
function App() {
  const hash = window.location.hash.replace("#", "");

  if (hash === "history") {
    return <History />;
  }

  if (hash === "transcribe") {
    return <Transcribe />;
  }

  // Default to settings
  return <Settings />;
}

createRoot(document.getElementById("root")!).render(<App />);
