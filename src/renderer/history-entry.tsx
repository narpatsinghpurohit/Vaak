import React from "react";
import { createRoot } from "react-dom/client";
import { History } from "./features/history/history";
import "./styles/global.css";
import "./styles/history.css";

createRoot(document.getElementById("root")!).render(<History />);
