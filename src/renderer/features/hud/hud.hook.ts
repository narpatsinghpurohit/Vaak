import { useEffect, useState } from "react";

export interface HudState {
  recording: boolean;
  level: number; // 0..1
  tentative: string; // in-flight (uncommitted) words
}

/** Subscribes to the main process's live dictation updates. */
export function useHud(): HudState {
  const [state, setState] = useState<HudState>({ recording: false, level: 0, tentative: "" });

  useEffect(() => {
    // The HUD window must be see-through — only the pill is visible.
    document.body.classList.add("hud-body");
    const off = window.voicePaste.onHudUpdate((data) => {
      setState({
        recording: !!data.recording,
        level: typeof data.level === "number" ? Math.max(0, Math.min(1, data.level)) : 0,
        tentative: data.tentative || "",
      });
    });
    return () => off?.();
  }, []);

  return state;
}
