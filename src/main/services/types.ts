export interface Settings {
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
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "local",
  cloud: {
    baseUrl: "https://api.groq.com/openai",
    apiKey: "",
    model: "whisper-large-v3-turbo",
  },
  local: {
    modelId: "ggml-base.en.bin",
  },
  language: "en",
  hotkey: "CommandOrControl+Shift+Space",
  historyHotkey: "CommandOrControl+Shift+H",
  autoPaste: false,
  showNotifications: true,
};

export interface HistoryEntry {
  id: number;
  text: string;
  provider: string;
  language: string;
  duration_secs: number;
  created_at: string;
  pinned: number;
}
