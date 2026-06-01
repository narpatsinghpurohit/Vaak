import React from "react";
import { useHud } from "./hud.hook";
import { HudView } from "./hud.view";

export function Hud() {
  const state = useHud();
  return <HudView {...state} />;
}
