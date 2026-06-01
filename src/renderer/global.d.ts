interface StreamingTuning {
  stepMs: number;
  maxBufferSec: number;
  pauseFlushMs: number;
}

interface Settings {
  provider: "local" | "cloud";
  cloud: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  local: {
    modelId: string;
  };
  language: string;
  hotkey: string;
  historyHotkey: string;
  autoPaste: boolean;
  showNotifications: boolean;
  inputDevice: string;
  mode: "batch" | "streaming";
  streaming: StreamingTuning;
}

interface InputDevice {
  name: string;
  isDefault: boolean;
  transport?: string;
}

interface HistoryEntry {
  id: number;
  text: string;
  provider: string;
  language: string;
  duration_secs: number;
  created_at: string;
  pinned: number;
}

interface ModelStatus {
  id: string;
  filename: string;
  displayName: string;
  sizeDisplay: string;
  description: string;
  recommended: boolean;
  downloaded: boolean;
  downloadedBytes: number;
  totalBytes: number;
}

interface DownloadProgress {
  filename: string;
  downloaded: number;
  total: number;
  speed: number;
  downloadedDisplay: string;
  totalDisplay: string;
  speedDisplay: string;
  percent: number;
}

type ModelRuntimeState = "idle" | "loading" | "loaded" | "offloaded" | "error";

interface ModelRuntimeStatus {
  state: ModelRuntimeState;
  modelId: string | null;
  modelPath: string | null;
  gpuRequested: boolean;
  loadStartedAt: number | null;
  loadedAt: number | null;
  loadDurationMs: number | null;
  lastTranscribeMs: number | null;
  lastTranscribeAudioSecs: number | null;
  lastError: string | null;
  logs: string[];
}

interface VoicePasteApi {
  getSettings: () => Promise<Settings>;
  saveSettings: (settings: Settings) => Promise<{ status: string }>;
  queryHistory: (search?: string, limit?: number, offset?: number) => Promise<HistoryEntry[]>;
  deleteHistory: (id: number) => Promise<{ status: string }>;
  clearHistory: () => Promise<{ status: string }>;
  togglePin: (id: number) => Promise<{ status: string }>;
  getHistoryText: (id: number) => Promise<string | null>;
  listModels: () => Promise<ModelStatus[]>;
  downloadModel: (filename: string) => Promise<{ status: string }>;
  cancelDownload: (filename: string) => Promise<{ status: string }>;
  deleteModel: (filename: string) => Promise<{ status: string }>;
  getModelProgress: (filename: string) => Promise<any>;
  listInputDevices: () => Promise<InputDevice[]>;
  checkAccessibility: () => Promise<boolean>;
  requestAccessibility: () => Promise<boolean>;
  onDownloadProgress: (callback: (data: DownloadProgress) => void) => () => void;
  onDownloadComplete: (callback: (data: { filename: string }) => void) => () => void;
  onDownloadError: (callback: (data: { filename: string; error: string }) => void) => () => void;
  getModelRuntime: () => Promise<ModelRuntimeStatus>;
  loadModelRuntime: () => Promise<{ status: string; reason?: string }>;
  offloadModelRuntime: () => Promise<{ status: string }>;
  reloadModelRuntime: () => Promise<{ status: string; reason?: string }>;
  onModelRuntimeStatus: (callback: (data: ModelRuntimeStatus) => void) => () => void;
  transcribeAudioPcm: (pcm16: ArrayBuffer) => Promise<{ text: string; provider: string }>;
  onHudUpdate: (callback: (data: HudUpdate) => void) => () => void;
}

interface HudUpdate {
  recording: boolean;
  level: number; // 0..1 mic level
  tentative: string; // in-flight (not-yet-committed) words
}

interface Window {
  voicePaste: VoicePasteApi;
}
