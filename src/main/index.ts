import {
  app,
  Tray,
  Menu,
  BrowserWindow,
  globalShortcut,
  clipboard,
  Notification,
} from "electron";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { exec, execSync } from "child_process";
import { systemPreferences } from "electron";
import { loadSettings, saveSettings, getAppDir } from "./services/settings";
import type { Settings } from "./services/types";
import { startRecording, stopRecording, isRecording } from "./services/audio";
import { transcribeCloud } from "./services/cloud-whisper";
import { transcribeLocal, preloadModel } from "./services/local-whisper";
import { startStreamingSession, stopStreamingSession, isStreamingActive } from "./services/streaming";
import { loadSilero } from "./services/silero";
import { insertText, ensureAccessibilityForInsertion } from "./services/insertion";
import { insertHistory } from "./services/history";
import { registerIpcHandlers } from "./ipc";
import { initLogger, getLogsText } from "./services/logger";
import { initTrayIcons, getIdleIcon, setTrayRef, setTrayState } from "./services/tray-icons";

// ── Single instance lock ──
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let settings: Settings;
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let historyWindow: BrowserWindow | null = null;
let transcribeWindow: BrowserWindow | null = null;
let logWindow: BrowserWindow | null = null;

const MODELS_DIR = () => {
  const dir = join(getAppDir(), "models");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

// ── App ready ──
app.whenReady().then(async () => {
  settings = loadSettings();

  // Init logger early so we capture everything
  initLogger(getAppDir());

  // Hide dock icon — tray-only app
  app.dock?.hide();

  // Register IPC handlers
  registerIpcHandlers(
    () => settings,
    (s) => {
      settings = s;
      saveSettings(s);
      registerHotkeys(); // Re-register in case hotkeys changed
    },
  );

  // Load tray icons (PNGs from assets/ + SVG wave frames)
  await initTrayIcons();
  createTray();

  // Register global hotkeys
  registerHotkeys();

  // Pre-load whisper model
  if (settings.provider === "local") {
    const modelPath = join(MODELS_DIR(), settings.local.modelId);
    if (existsSync(modelPath)) {
      try {
        preloadModel(MODELS_DIR(), settings.local.modelId);
      } catch (e) {
        console.error("Failed to preload model:", e);
      }
    } else {
      console.warn(`Model not found: ${modelPath}`);
    }
  }

  // Warm up the Silero VAD so it's ready before the first live dictation
  // (load is lazy + guarded; failure just falls back to the RMS detector).
  if (settings.mode === "streaming") {
    loadSilero().catch(() => {});
  }

  console.log("Vaak v0.1 started — provider:", settings.provider);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// No window-all-closed quit — tray app stays alive
app.on("window-all-closed", () => {
  // Tray app — don't quit when all windows close
});

// ── Tray ──

function createTray() {
  tray = new Tray(getIdleIcon());
  tray.setToolTip("Vaak");
  setTrayRef(tray);
  setTrayState("idle");
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const providerLabel =
    settings.provider === "local"
      ? `Local (${settings.local.modelId})`
      : `Cloud (${settings.cloud.baseUrl.replace("https://", "").split("/")[0]})`;

  const modelExists =
    settings.provider === "local"
      ? existsSync(join(MODELS_DIR(), settings.local.modelId))
      : true;

  const menu = Menu.buildFromTemplate([
    {
      label: isRecording() ? "Stop Recording" : "Start Recording",
      click: () => toggleRecording(),
    },
    { type: "separator" },
    { label: `Provider: ${providerLabel}`, enabled: false },
    {
      label: settings.provider === "local" ? "Switch to Cloud" : "Switch to Local",
      click: () => {
        settings.provider = settings.provider === "local" ? "cloud" : "local";
        saveSettings(settings);
        if (settings.provider === "local") {
          try { preloadModel(MODELS_DIR(), settings.local.modelId); } catch {}
        }
        updateTrayMenu();
      },
    },
    { type: "separator" },
    { label: modelExists ? "Model: Ready" : "Model not found!", enabled: false },
    { type: "separator" },
    { label: "History", accelerator: settings.historyHotkey, click: () => toggleHistoryWindow() },
    { label: "Transcribe File...", click: () => openTranscribeWindow() },
    { label: "Settings...", click: () => openSettingsWindow() },
    { type: "separator" },
    { label: "View Logs...", click: () => openLogWindow() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
}

// ── Global Hotkeys ──

function registerHotkeys() {
  globalShortcut.unregisterAll();

  const recordOk = globalShortcut.register(settings.hotkey, () => {
    toggleRecording().catch((e) => console.error("toggleRecording error:", e));
  });
  console.log(`Hotkey "${settings.hotkey}" registered:`, recordOk);

  const historyOk = globalShortcut.register(settings.historyHotkey, () => {
    toggleHistoryWindow();
  });
  console.log(`Hotkey "${settings.historyHotkey}" registered:`, historyOk);
}

// ── Auto-paste (simulate Cmd+V) ──

function simulatePaste(): Promise<void> {
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted) {
    console.warn("[auto-paste] No Accessibility permission — prompting user");
    // Opens System Settings → Accessibility with a prompt
    systemPreferences.isTrustedAccessibilityClient(true);
    new Notification({
      title: "Vaak — Accessibility Required",
      body: "Auto-paste needs Accessibility permission. Please enable Vaak in System Settings and try again.",
      silent: false,
    }).show();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    exec(
      `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
      (err) => {
        if (err) console.error("[auto-paste] Failed:", err.message);
        else console.log("[auto-paste] Pasted");
        resolve();
      },
    );
  });
}

// ── Streaming Flow (live word-by-word dictation) ──

let streamToggleBusy = false;

async function toggleStreaming() {
  // Guard against a second hotkey press landing mid start/stop.
  if (streamToggleBusy) {
    console.log("[stream] toggle ignored — busy");
    return;
  }
  streamToggleBusy = true;
  try {
    await doToggleStreaming();
  } finally {
    streamToggleBusy = false;
  }
}

async function doToggleStreaming() {
  if (isStreamingActive()) {
    console.log("Stopping streaming session...");
    setTrayState("transcribing");
    try {
      const { fullText, durationSecs } = await stopStreamingSession();
      console.log(`Streaming stopped: ${durationSecs.toFixed(1)}s, "${fullText.slice(0, 60)}"`);
      if (fullText) {
        try {
          insertHistory(fullText, settings.provider, settings.language, durationSecs);
        } catch (dbErr: unknown) {
          console.error("History save failed:", dbErr instanceof Error ? dbErr.message : dbErr);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Streaming stop FAILED:", msg);
      new Notification({ title: "Vaak — Error", body: msg, silent: false }).show();
    }
    setTrayState("idle");
    updateTrayMenu();
    return;
  }

  // Start a streaming session.
  const modelPath = join(MODELS_DIR(), settings.local.modelId);
  if (!existsSync(modelPath)) {
    new Notification({
      title: "Vaak — Model not found",
      body: `Download ${settings.local.modelId} in Settings to use live dictation.`,
      silent: false,
    }).show();
    return;
  }
  // Typing into the focused app needs Accessibility — prompt and bail if missing
  // (a session without it would record but type nothing).
  if (!ensureAccessibilityForInsertion()) {
    console.warn("[stream] no Accessibility permission — not starting");
    return;
  }

  console.log("Starting streaming session...");
  try {
    setTrayState("streaming");
    setTimeout(() => updateTrayMenu(), 500);
    startStreamingSession(
      {
        modelsDir: MODELS_DIR(),
        modelId: settings.local.modelId,
        language: settings.language,
        tuning: settings.streaming,
      },
      {
        onCommit: (text) => {
          void insertText(text);
        },
        // onTentative / onLevel drive the Phase 2 HUD; no-ops for now.
        onTentative: () => {},
        onLevel: () => {},
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Failed to start streaming:", msg);
    setTrayState("idle");
    updateTrayMenu();
  }
}

// ── Recording Flow ──

async function toggleRecording() {
  console.log("toggleRecording called — isRecording:", isRecording());

  // Live streaming is local-only in Phase 1 (cloud would need chunked uploads).
  if (settings.mode === "streaming" && settings.provider === "local") {
    return toggleStreaming();
  }

  if (isRecording()) {
    console.log("Stopping recording...");
    setTrayState("transcribing");

    try {
      console.log("Calling stopRecording()...");
      const { wavBuffer, durationSecs } = await stopRecording();
      console.log(`Audio captured: ${wavBuffer.length} bytes, ${durationSecs.toFixed(1)}s`);

      console.log(`Transcribing with provider: ${settings.provider}`);
      let text: string;
      if (settings.provider === "cloud") {
        console.log(`Cloud: ${settings.cloud.baseUrl} model=${settings.cloud.model}`);
        text = await transcribeCloud(wavBuffer, settings.language, settings.cloud);
      } else {
        const modelPath = join(MODELS_DIR(), settings.local.modelId);
        console.log(`Local: model=${settings.local.modelId} exists=${existsSync(modelPath)}`);
        text = await transcribeLocal(wavBuffer, MODELS_DIR(), settings.local.modelId, settings.language);
      }
      console.log("Transcription result:", text ? `"${text.slice(0, 80)}"` : "(empty)");

      if (text) {
        clipboard.writeText(text);
        console.log("Text copied to clipboard");

        if (settings.autoPaste) {
          // Simulate Cmd+V to paste into focused input
          console.log("Auto-pasting...");
          await simulatePaste();
        }

        try {
          insertHistory(text, settings.provider, settings.language, durationSecs);
          console.log("History entry saved");
        } catch (dbErr: unknown) {
          console.error("History save failed:", dbErr instanceof Error ? dbErr.message : dbErr);
        }
        if (settings.showNotifications) {
          new Notification({
            title: "Vaak",
            body: text.length > 100 ? text.slice(0, 100) + "..." : text,
            silent: true,
          }).show();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Transcription FAILED:", msg);
      if (err instanceof Error && err.stack) {
        console.error("Stack:", err.stack);
      }
      new Notification({
        title: "Vaak — Error",
        body: msg,
        silent: false,
      }).show();
    }

    setTrayState("idle");
    updateTrayMenu();
  } else {
    console.log("Starting recording...");
    try {
      startRecording();
      console.log("Recording started OK");
      setTrayState("recording");
      setTimeout(() => updateTrayMenu(), 500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to start recording:", msg);
      if (err instanceof Error && err.stack) {
        console.error("Stack:", err.stack);
      }
      setTrayState("idle");
    }
  }
}

// ── Log Window ──

function openLogWindow() {
  if (logWindow) {
    logWindow.focus();
    // Refresh content
    logWindow.webContents.executeJavaScript(
      `document.getElementById("logs").textContent = ${JSON.stringify(getLogsText())};
       document.getElementById("logs").scrollTop = document.getElementById("logs").scrollHeight;`
    );
    return;
  }

  logWindow = new BrowserWindow({
    title: "Vaak Logs",
    width: 700,
    height: 500,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: SF Mono, Menlo, monospace; font-size: 11px; background: #1c1c1e; color: #e5e5e7; height: 100vh; display: flex; flex-direction: column; }
  .toolbar { padding: 8px 12px; background: #2c2c2e; border-bottom: 1px solid #48484a; display: flex; justify-content: space-between; align-items: center; -webkit-app-region: drag; }
  .toolbar span { font-weight: 600; font-size: 12px; }
  .toolbar button { -webkit-app-region: no-drag; padding: 3px 10px; border-radius: 4px; border: 1px solid #48484a; background: #3a3a3c; color: #e5e5e7; cursor: pointer; font-family: inherit; font-size: 11px; }
  .toolbar button:hover { background: #48484a; }
  #logs { flex: 1; overflow-y: auto; padding: 8px 12px; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
  .ERR { color: #ff6b6b; }
  .WARN { color: #ffd60a; }
</style></head><body>
<div class="toolbar">
  <span>Vaak Logs</span>
  <button onclick="fetch('__refresh__')">Refresh</button>
</div>
<pre id="logs">${getLogsText().replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>
<script>
  const el = document.getElementById("logs");
  el.scrollTop = el.scrollHeight;
</script>
</body></html>`;

  logWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Auto-refresh every 2 seconds
  const refreshInterval = setInterval(() => {
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.webContents.executeJavaScript(
        `document.getElementById("logs").textContent = decodeURIComponent("${encodeURIComponent(getLogsText())}");
         document.getElementById("logs").scrollTop = document.getElementById("logs").scrollHeight;`
      ).catch(() => {});
    }
  }, 2000);

  logWindow.on("closed", () => {
    clearInterval(refreshInterval);
    logWindow = null;
  });
}

// ── Settings Window ──

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    title: "Vaak Settings",
    width: 560,
    height: 700,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    settingsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#settings`);
  } else {
    settingsWindow.loadFile(join(__dirname, "../renderer/index.html"), { hash: "settings" });
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── History Window ──

function toggleHistoryWindow() {
  if (historyWindow) {
    historyWindow.close();
    historyWindow = null;
    return;
  }

  historyWindow = new BrowserWindow({
    title: "Vaak History",
    width: 420,
    height: 520,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    historyWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#history`);
  } else {
    historyWindow.loadFile(join(__dirname, "../renderer/index.html"), { hash: "history" });
  }

  historyWindow.on("blur", () => {
    setTimeout(() => {
      try { historyWindow?.close(); } catch {}
      historyWindow = null;
    }, 200);
  });

  historyWindow.on("closed", () => {
    historyWindow = null;
  });
}

// ── Transcribe Window ──

function openTranscribeWindow() {
  if (transcribeWindow) {
    transcribeWindow.focus();
    return;
  }

  transcribeWindow = new BrowserWindow({
    title: "Vaak — Transcribe File",
    width: 600,
    height: 500,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    transcribeWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#transcribe`);
  } else {
    transcribeWindow.loadFile(join(__dirname, "../renderer/index.html"), { hash: "transcribe" });
  }

  transcribeWindow.on("closed", () => {
    transcribeWindow = null;
  });
}
