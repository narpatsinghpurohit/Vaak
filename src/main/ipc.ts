import { ipcMain, BrowserWindow, systemPreferences } from "electron";
import { loadSettings, saveSettings, getAppDir } from "./services/settings";
import type { Settings, HistoryEntry } from "./services/types";
import {
  queryHistory,
  deleteHistoryEntry,
  clearHistory,
  togglePin,
  getHistoryEntryText,
} from "./services/history";
import {
  getModelStatuses,
  downloadModel,
  cancelDownload,
  deleteModel,
  getDownloadProgress,
  formatBytes,
  formatSpeed,
} from "./services/model-manager";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

function getModelsDir(): string {
  const dir = join(getAppDir(), "models");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerIpcHandlers(
  getSettings: () => Settings,
  setSettings: (s: Settings) => void,
): void {
  const modelsDir = getModelsDir();

  // ── Settings ──
  ipcMain.handle("settings:get", () => getSettings());

  // ── Accessibility permission check (for auto-paste) ──
  ipcMain.handle("accessibility:check", () => {
    return systemPreferences.isTrustedAccessibilityClient(false);
  });
  ipcMain.handle("accessibility:request", () => {
    // passing true opens the System Preferences pane and prompts the user
    return systemPreferences.isTrustedAccessibilityClient(true);
  });
  ipcMain.handle("settings:save", (_e, settings: Settings) => {
    setSettings(settings);
    return { status: "saved" };
  });

  // ── History ──
  ipcMain.handle("history:query", (_e, search?: string, limit?: number, offset?: number) => {
    return queryHistory(search, limit, offset);
  });
  ipcMain.handle("history:delete", (_e, id: number) => {
    deleteHistoryEntry(id);
    return { status: "deleted" };
  });
  ipcMain.handle("history:clear", () => {
    clearHistory();
    return { status: "cleared" };
  });
  ipcMain.handle("history:togglePin", (_e, id: number) => {
    togglePin(id);
    return { status: "toggled" };
  });
  ipcMain.handle("history:getText", (_e, id: number) => {
    return getHistoryEntryText(id);
  });

  // ── Models ──
  ipcMain.handle("models:list", () => {
    const statuses = getModelStatuses(modelsDir);
    for (const s of statuses) {
      const prog = getDownloadProgress(s.filename);
      if (prog) {
        s.downloadedBytes = prog.downloaded;
        s.totalBytes = prog.total;
      }
    }
    return statuses;
  });

  ipcMain.handle("models:download", (_e, filename: string) => {
    downloadModel(modelsDir, filename, (downloaded, total, speed) => {
      // Send progress to all renderer windows
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("models:downloadProgress", {
          filename,
          downloaded,
          total,
          speed,
          downloadedDisplay: formatBytes(downloaded),
          totalDisplay: formatBytes(total),
          speedDisplay: formatSpeed(speed),
          percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
        });
      }
    })
      .then(() => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("models:downloadComplete", { filename });
        }
      })
      .catch((err) => {
        console.error(`Download failed: ${filename}:`, err.message);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("models:downloadError", { filename, error: err.message });
        }
      });
    return { status: "started" };
  });

  ipcMain.handle("models:cancel", (_e, filename: string) => {
    cancelDownload(filename);
    return { status: "cancelled" };
  });

  ipcMain.handle("models:delete", (_e, filename: string) => {
    deleteModel(modelsDir, filename);
    return { status: "deleted" };
  });

  ipcMain.handle("models:getProgress", (_e, filename: string) => {
    const prog = getDownloadProgress(filename);
    if (!prog) return { downloading: false };
    return {
      downloading: true,
      ...prog,
      downloadedDisplay: formatBytes(prog.downloaded),
      totalDisplay: formatBytes(prog.total),
      speedDisplay: formatSpeed(prog.speed),
      percent: prog.total > 0 ? Math.round((prog.downloaded / prog.total) * 100) : 0,
    };
  });
}
