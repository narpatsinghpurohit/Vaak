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
  checkAccessibility: () => Promise<boolean>;
  requestAccessibility: () => Promise<boolean>;
  onDownloadProgress: (callback: (data: DownloadProgress) => void) => () => void;
  onDownloadComplete: (callback: (data: { filename: string }) => void) => () => void;
  onDownloadError: (callback: (data: { filename: string; error: string }) => void) => () => void;
}

interface Window {
  voicePaste: VoicePasteApi;
}
