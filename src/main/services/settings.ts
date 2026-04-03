import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { type Settings, DEFAULT_SETTINGS } from "./types";

let appDir: string | null = null;

export function getAppDir(): string {
  if (!appDir) {
    appDir = join(app.getPath("userData"));
    if (!existsSync(appDir)) {
      mkdirSync(appDir, { recursive: true });
    }
  }
  return appDir;
}

function settingsPath(): string {
  return join(getAppDir(), "settings.json");
}

export function loadSettings(): Settings {
  try {
    const p = settingsPath();
    if (existsSync(p)) {
      const data = readFileSync(p, "utf-8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings): void {
  getAppDir();
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
