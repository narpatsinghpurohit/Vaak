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
  onProviderChange: (provider: "local" | "cloud") => void;
  onSelectModel: (filename: string) => void;
  onDownloadModel: (filename: string) => void;
  onCancelDownload: (filename: string) => void;
  onDeleteModel: (filename: string, displayName: string) => void;
  onFieldChange: (updater: (s: Settings) => Settings) => void;
  onDebouncedChange: (updater: (s: Settings) => Settings) => void;
}

export function SettingsView({
  settings,
  models,
  downloading,
  loaded,
  onProviderChange,
  onSelectModel,
  onDownloadModel,
  onCancelDownload,
  onDeleteModel,
  onFieldChange,
  onDebouncedChange,
}: SettingsViewProps) {
  if (!loaded || !settings) {
    return <div style={{ padding: 24, color: "var(--fg-muted)" }}>Loading...</div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, marginBottom: 20 }}>Vaak Settings</h2>

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
    </div>
  );
}
