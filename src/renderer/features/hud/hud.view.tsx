import React, { useEffect, useRef, useState } from "react";
import type { HudState } from "./hud.hook";

const BARS = 28;

export function HudView({ recording, level, tentative }: HudState) {
  // rAF tick drives the flowing wave; level is eased for smoothness.
  const [, setTick] = useState(0);
  const tickRef = useRef(0);
  const levelRef = useRef(0);
  const smoothRef = useRef(0);
  levelRef.current = level;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      smoothRef.current += (levelRef.current - smoothRef.current) * 0.25;
      tickRef.current += 1;
      setTick(tickRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const lvl = smoothRef.current;
  const t = tickRef.current;
  const bars = [];
  for (let i = 0; i < BARS; i++) {
    const wave = 0.5 + 0.5 * Math.sin(t * 0.18 + i * 0.5); // flowing motion
    const center = 1 - Math.abs((i - (BARS - 1) / 2) / ((BARS - 1) / 2)); // taller mid
    const h = Math.max(0.09, Math.min(1, lvl * (0.35 + 0.65 * wave) * (0.45 + 0.55 * center)));
    bars.push(<span key={i} className="hud-bar" style={{ height: `${h * 100}%` }} />);
  }

  const text = tentative.trim();
  return (
    <div className={`hud-root ${recording ? "in" : "out"}`}>
      <div className="hud-pill">
        <div className="hud-wave">{bars}</div>
        <div className={`hud-text ${text ? "" : "muted"}`}>{text || "Listening…"}</div>
      </div>
    </div>
  );
}
