import React from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "./features/settings/settings";
import "./styles/global.css";
import "./styles/settings.css";

createRoot(document.getElementById("root")!).render(<Settings />);
