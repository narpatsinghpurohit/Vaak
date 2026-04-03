import React from "react";

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
        <label>Hotkeys</label>
        <div style={{ color: "var(--fg-muted)" }}>
          <strong>{settings.hotkey}</strong> — Record/Stop &nbsp;{" "}
          <strong>{settings.historyHotkey}</strong> — History
        </div>
      </div>
    </div>
  );
}
