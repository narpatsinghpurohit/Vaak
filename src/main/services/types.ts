export interface StreamingTuning {
  /** How much new audio (ms) to accumulate before re-transcribing. */
  stepMs: number;
  /** Hard cap on the rolling buffer (s); trimmed to last commit beyond this. */
  maxBufferSec: number;
  /** Silence (ms) that marks an utterance boundary → flush the trailing tail. */
  pauseFlushMs: number;
}

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
  // "batch": record → stop → transcribe whole clip → paste (the classic flow).
  // "streaming": transcribe live word-by-word into the focused input as you speak.
  mode: "batch" | "streaming";
  streaming: StreamingTuning;
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
  mode: "streaming",
  streaming: {
    stepMs: 800,
    maxBufferSec: 12,
    pauseFlushMs: 700,
  },
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
