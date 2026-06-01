import React from "react";

/** Convert a keyboard event into an Electron accelerator string */
function buildCombo(e: React.KeyboardEvent): string | null {
  // Ignore lone modifier keys
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  // Need at least one modifier
  if (parts.length === 0) return null;

  // Map special keys to Electron accelerator names
  const keyMap: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Escape",
    Enter: "Return",
    Backspace: "Backspace",
    Delete: "Delete",
    Tab: "Tab",
  };

  const key = keyMap[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);

  return parts.join("+");
}

interface ModelRowProps {
  model: ModelStatus;
  isActive: boolean;
  downloading: DownloadProgress | undefined;
  onSelect: (filename: string) => void;
  onDownload: (filename: string) => void;
  onCancel: (filename: string) => void;
  onDelete: (filename: string, displayName: string) => void;
}

function ModelRow({ model, isActive, downloading, onSelect, onDownload, onCancel, onDelete }: ModelRowProps) {
  return (
    <div className={`model-row ${isActive ? "selected" : ""}`}>
      <div className="model-info">
        <div className="model-name">
          {model.displayName}
          {model.recommended && <span className="badge">recommended</span>}
        </div>
        <div className="model-meta">
          {model.sizeDisplay} | {model.description}
        </div>
        {downloading && (
          <>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${downloading.percent}%` }} />
            </div>
            <div className="progress-text">
              {downloading.downloadedDisplay} / {downloading.totalDisplay} — {downloading.speedDisplay}
            </div>
          </>
        )}
      </div>
      <div className="model-actions">
        {model.downloaded ? (
          <>
            {isActive ? (
              <span className="btn-active">Active</span>
            ) : (
              <button className="btn" onClick={() => onSelect(model.filename)}>Select</button>
            )}
            <button className="btn btn-danger" onClick={() => onDelete(model.filename, model.displayName)}>
              Delete
            </button>
          </>
        ) : downloading ? (
          <>
            <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{downloading.percent}%</span>
            <button className="btn btn-danger" onClick={() => onCancel(model.filename)}>Cancel</button>
          </>
        ) : (
          <button className="btn" onClick={() => onDownload(model.filename)}>Download</button>
        )}
      </div>
    </div>
  );
}

interface SettingsViewProps {
  settings: Settings | null;
  models: ModelStatus[];
  downloading: Record<string, DownloadProgress>;
  loaded: boolean;
  modelRuntime: ModelRuntimeStatus | null;
  onProviderChange: (provider: "local" | "cloud") => void;
  onSelectModel: (filename: string) => void;
  onDownloadModel: (filename: string) => void;
  onCancelDownload: (filename: string) => void;
  onDeleteModel: (filename: string, displayName: string) => void;
  onFieldChange: (updater: (s: Settings) => Settings) => void;
  onDebouncedChange: (updater: (s: Settings) => Settings) => void;
  onLoadModel: () => Promise<void> | void;
  onOffloadModel: () => Promise<void> | void;
  onReloadModel: () => Promise<void> | void;
}

const STATE_LABEL: Record<ModelRuntimeState, string> = {
  idle: "Not loaded",
  loading: "Loading…",
  loaded: "Loaded",
  offloaded: "Offloaded",
  error: "Error",
};

const STATE_COLOR: Record<ModelRuntimeState, string> = {
  idle: "var(--fg-muted)",
  loading: "var(--accent)",
  loaded: "var(--success)",
  offloaded: "var(--fg-muted)",
  error: "var(--danger)",
};

function backendLabel(rt: ModelRuntimeStatus): string {
  if (!rt.gpuRequested) return "CPU (GPU disabled)";
  return "Metal GPU";
}

function formatLoadTime(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatTranscribeTime(ms: number | null, audioSecs: number | null): string {
  if (ms == null) return "—";
  const timeStr = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
  if (audioSecs == null || audioSecs <= 0) return timeStr;
  const realtime = (audioSecs * 1000) / ms;
  return `${timeStr} · ${realtime.toFixed(1)}× realtime (${audioSecs.toFixed(1)}s audio)`;
}

function ModelRuntimePanel({
  runtime,
  canLoad,
  onLoad,
  onOffload,
  onReload,
}: {
  runtime: ModelRuntimeStatus | null;
  canLoad: boolean;
  onLoad: () => Promise<void> | void;
  onOffload: () => Promise<void> | void;
  onReload: () => Promise<void> | void;
}) {
  const [showLogs, setShowLogs] = React.useState(false);
  const rt = runtime;

  if (!rt) {
    return (
      <div className="runtime-panel">
        <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Runtime status unavailable.</div>
      </div>
    );
  }

  const isLoaded = rt.state === "loaded";
  const isLoading = rt.state === "loading";
  const isBusy = isLoading;

  return (
    <div className="runtime-panel">
      <div className="runtime-row">
        <span className="runtime-label">Status</span>
        <span className="runtime-badge" style={{ color: STATE_COLOR[rt.state] }}>
          <span className="runtime-dot" style={{ background: STATE_COLOR[rt.state] }} />
          {STATE_LABEL[rt.state]}
        </span>
      </div>

      <div className="runtime-row">
        <span className="runtime-label">Backend</span>
        <span className="runtime-value">{backendLabel(rt)}</span>
      </div>

      {rt.modelId && (
        <div className="runtime-row">
          <span className="runtime-label">Model</span>
          <span className="runtime-value" title={rt.modelPath ?? ""}>{rt.modelId}</span>
        </div>
      )}

      <div className="runtime-row">
        <span className="runtime-label">Load time</span>
        <span className="runtime-value">{formatLoadTime(rt.loadDurationMs)}</span>
      </div>

      <div className="runtime-row">
        <span className="runtime-label">Last transcribe</span>
        <span className="runtime-value">
          {formatTranscribeTime(rt.lastTranscribeMs, rt.lastTranscribeAudioSecs)}
        </span>
      </div>

      {rt.lastError && (
        <div className="runtime-row">
          <span className="runtime-label">Error</span>
          <span className="runtime-value" style={{ color: "var(--danger)" }}>{rt.lastError}</span>
        </div>
      )}

      <div className="hint" style={{ marginTop: 8 }}>
        On Apple Silicon + Metal, expect load &lt; 500 ms and transcribe ≥ 10× realtime.
        Slower than that means CPU fallback — check the worker logs.
      </div>

      <div className="runtime-actions">
        {!isLoaded && (
          <button className="btn" disabled={isBusy || !canLoad} onClick={() => onLoad()}>
            {isLoading ? "Loading…" : "Load model"}
          </button>
        )}
        {isLoaded && (
          <button className="btn" disabled={isBusy} onClick={() => onOffload()}>
            Offload
          </button>
        )}
        <button className="btn" disabled={isBusy || !canLoad} onClick={() => onReload()}>
          Reload
        </button>
        <button className="btn" onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? "Hide logs" : "Show logs"}
        </button>
      </div>

      {showLogs && (
        <pre className="runtime-logs">
          {rt.logs.length === 0 ? "(no logs yet)" : rt.logs.join("\n")}
        </pre>
      )}
    </div>
  );
}

export function SettingsView({
  settings,
  models,
  downloading,
  loaded,
  modelRuntime,
  onProviderChange,
  onSelectModel,
  onDownloadModel,
  onCancelDownload,
  onDeleteModel,
  onFieldChange,
  onDebouncedChange,
  onLoadModel,
  onOffloadModel,
  onReloadModel,
}: SettingsViewProps) {
  if (!loaded || !settings) {
    return <div style={{ padding: 24, color: "var(--fg-muted)" }}>Loading...</div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, marginBottom: 20 }}>Vaak Settings</h2>

      {/* Mode */}
      <div className="section">
        <label>Dictation Mode</label>
        <div className="chip-group">
          <button
            className={`chip ${settings.mode === "streaming" ? "active" : ""}`}
            onClick={async () => {
              const hasAccess = await window.voicePaste.checkAccessibility();
              if (!hasAccess) await window.voicePaste.requestAccessibility();
              onFieldChange((s) => ({ ...s, mode: "streaming" }));
            }}
          >
            Live (streaming)
          </button>
          <button
            className={`chip ${settings.mode === "batch" ? "active" : ""}`}
            onClick={() => onFieldChange((s) => ({ ...s, mode: "batch" }))}
          >
            Classic (paste on stop)
          </button>
        </div>
        <div className="hint">
          {settings.mode === "streaming" ? (
            <>
              Text appears word-by-word in the focused field as you speak; press the hotkey again to
              stop. Uses the local model and requires Accessibility permission.
              {settings.provider === "cloud" && (
                <> <strong>Live mode runs on the local model</strong> — the Cloud provider is used only in Classic mode.</>
              )}
            </>
          ) : (
            <>Records until you press the hotkey again, then transcribes the whole clip and pastes it.</>
          )}
        </div>
      </div>

      {/* Provider */}
      <div className="section">
        <label>Provider</label>
        <div className="chip-group">
          <button
            className={`chip ${settings.provider === "local" ? "active" : ""}`}
            onClick={() => onProviderChange("local")}
          >
            Local (Metal GPU)
          </button>
          <button
            className={`chip ${settings.provider === "cloud" ? "active" : ""}`}
            onClick={() => onProviderChange("cloud")}
          >
            Cloud (OpenAI-compatible)
          </button>
        </div>
      </div>

      {/* Cloud settings */}
      {settings.provider === "cloud" && (
        <>
          <div className="section">
            <label>Base URL</label>
            <input
              value={settings.cloud.baseUrl}
              placeholder="https://api.groq.com/openai"
              onChange={(e) =>
                onDebouncedChange((s) => ({
                  ...s,
                  cloud: { ...s.cloud, baseUrl: e.target.value },
                }))
              }
            />
            <div className="hint">
              Groq: https://api.groq.com/openai | OpenAI: https://api.openai.com
            </div>
          </div>
          <div className="section">
            <label>API Key</label>
            <input
              type="password"
              value={settings.cloud.apiKey}
              placeholder="Enter API key..."
              onChange={(e) =>
                onDebouncedChange((s) => ({
                  ...s,
                  cloud: { ...s.cloud, apiKey: e.target.value },
                }))
              }
            />
          </div>
          <div className="section">
            <label>Model</label>
            <input
              value={settings.cloud.model}
              placeholder="whisper-large-v3-turbo"
              onChange={(e) =>
                onDebouncedChange((s) => ({
                  ...s,
                  cloud: { ...s.cloud, model: e.target.value },
                }))
              }
            />
          </div>
        </>
      )}

      {/* Local model list */}
      {settings.provider === "local" && (
        <>
          <div className="section">
            <label>Whisper Models</label>
            <div className="model-list">
              {models.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  isActive={settings.local.modelId === m.filename}
                  downloading={downloading[m.filename]}
                  onSelect={onSelectModel}
                  onDownload={onDownloadModel}
                  onCancel={onCancelDownload}
                  onDelete={onDeleteModel}
                />
              ))}
            </div>
          </div>

          <div className="section">
            <label>Model Runtime</label>
            <ModelRuntimePanel
              runtime={modelRuntime}
              canLoad={Boolean(
                settings.local.modelId &&
                  models.find((m) => m.filename === settings.local.modelId)?.downloaded,
              )}
              onLoad={onLoadModel}
              onOffload={onOffloadModel}
              onReload={onReloadModel}
            />
          </div>
        </>
      )}

      {/* Language */}
      <div className="section">
        <label>Language</label>
        <select
          value={settings.language}
          onChange={(e) =>
            onFieldChange((s) => ({ ...s, language: e.target.value }))
          }
        >
          <option value="en">English</option>
          <option value="auto">Auto-detect</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="ja">Japanese</option>
          <option value="zh">Chinese</option>
        </select>
      </div>

      {/* Hotkeys */}
      <div className="section">
        <label>Record / Stop Hotkey</label>
        <input
          readOnly
          value={settings.hotkey}
          onKeyDown={(e) => {
            e.preventDefault();
            const combo = buildCombo(e);
            if (combo) onFieldChange((s) => ({ ...s, hotkey: combo }));
          }}
          placeholder="Press a key combination..."
          style={{ cursor: "pointer" }}
        />
        <div className="hint">Click and press your desired key combination</div>
      </div>

      <div className="section">
        <label>History Hotkey</label>
        <input
          readOnly
          value={settings.historyHotkey}
          onKeyDown={(e) => {
            e.preventDefault();
            const combo = buildCombo(e);
            if (combo) onFieldChange((s) => ({ ...s, historyHotkey: combo }));
          }}
          placeholder="Press a key combination..."
          style={{ cursor: "pointer" }}
        />
      </div>

      {/* Auto-paste */}
      <div className="section">
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={settings.autoPaste}
            onChange={async (e) => {
              const enabling = e.target.checked;
              if (enabling) {
                const hasAccess = await window.voicePaste.checkAccessibility();
                if (!hasAccess) {
                  // Opens System Preferences → Accessibility
                  await window.voicePaste.requestAccessibility();
                }
              }
              onFieldChange((s) => ({ ...s, autoPaste: enabling }));
            }}
            style={{ width: "auto", cursor: "pointer" }}
          />
          Auto-paste after transcription
        </label>
        <div className="hint">
          Automatically pastes transcribed text into the focused input field (simulates Cmd+V).
          Requires Accessibility permission — macOS will prompt you to grant it.
        </div>
      </div>

      {/* Notifications */}
      <div className="section">
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={settings.showNotifications}
            onChange={(e) =>
              onFieldChange((s) => ({ ...s, showNotifications: e.target.checked }))
            }
            style={{ width: "auto", cursor: "pointer" }}
          />
          Show notifications
        </label>
        <div className="hint">
          Shows a notification with the transcribed text after each dictation.
          Error and permission alerts are always shown.
        </div>
      </div>
    </div>
  );
}
