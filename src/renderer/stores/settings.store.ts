import { create } from "zustand";

interface SettingsState {
  settings: Settings | null;
  models: ModelStatus[];
  downloading: Record<string, DownloadProgress>;
  loaded: boolean;
  modelRuntime: ModelRuntimeStatus | null;
  load: () => Promise<void>;
  save: (settings: Settings) => Promise<void>;
  loadModels: () => Promise<void>;
  startDownload: (filename: string) => Promise<void>;
  cancelDownload: (filename: string) => Promise<void>;
  deleteModel: (filename: string) => Promise<void>;
  selectModel: (filename: string) => void;
  setProvider: (provider: "local" | "cloud") => void;
  loadModelRuntime: () => Promise<void>;
  triggerLoadModel: () => Promise<void>;
  triggerOffloadModel: () => Promise<void>;
  triggerReloadModel: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  models: [],
  downloading: {},
  loaded: false,
  modelRuntime: null,

  load: async () => {
    const settings = await window.voicePaste.getSettings();
    set({ settings, loaded: true });
  },

  save: async (settings: Settings) => {
    set({ settings });
    await window.voicePaste.saveSettings(settings);
  },

  loadModels: async () => {
    const models = await window.voicePaste.listModels();
    set({ models });
  },

  startDownload: async (filename: string) => {
    set((s) => ({
      downloading: {
        ...s.downloading,
        [filename]: {
          filename,
          downloaded: 0,
          total: 0,
          speed: 0,
          downloadedDisplay: "0 MB",
          totalDisplay: "...",
          speedDisplay: "...",
          percent: 0,
        },
      },
    }));
    await window.voicePaste.downloadModel(filename);
  },

  cancelDownload: async (filename: string) => {
    await window.voicePaste.cancelDownload(filename);
    set((s) => {
      const downloading = { ...s.downloading };
      delete downloading[filename];
      return { downloading };
    });
  },

  deleteModel: async (filename: string) => {
    await window.voicePaste.deleteModel(filename);
    const { settings } = get();
    if (settings?.local.modelId === filename) {
      const updated = { ...settings, local: { ...settings.local, modelId: "" } };
      get().save(updated);
    }
    get().loadModels();
  },

  selectModel: (filename: string) => {
    const { settings } = get();
    if (!settings) return;
    const updated = { ...settings, local: { ...settings.local, modelId: filename } };
    get().save(updated);
  },

  setProvider: (provider: "local" | "cloud") => {
    const { settings } = get();
    if (!settings) return;
    const updated = { ...settings, provider };
    get().save(updated);
    if (provider === "local") get().loadModels();
  },

  loadModelRuntime: async () => {
    const status = await window.voicePaste.getModelRuntime();
    set({ modelRuntime: status });
  },

  triggerLoadModel: async () => {
    await window.voicePaste.loadModelRuntime();
  },

  triggerOffloadModel: async () => {
    await window.voicePaste.offloadModelRuntime();
  },

  triggerReloadModel: async () => {
    await window.voicePaste.reloadModelRuntime();
  },
}));

// Listen for download events from main process
if (typeof window !== "undefined" && window.voicePaste) {
  window.voicePaste.onDownloadProgress((data) => {
    useSettingsStore.setState((s) => ({
      downloading: { ...s.downloading, [data.filename]: data },
    }));
  });

  window.voicePaste.onDownloadComplete((data) => {
    useSettingsStore.setState((s) => {
      const downloading = { ...s.downloading };
      delete downloading[data.filename];
      return { downloading };
    });
    useSettingsStore.getState().loadModels();
  });

  window.voicePaste.onDownloadError((data) => {
    useSettingsStore.setState((s) => {
      const downloading = { ...s.downloading };
      delete downloading[data.filename];
      return { downloading };
    });
    console.error(`Download failed: ${data.filename}: ${data.error}`);
  });

  window.voicePaste.onModelRuntimeStatus((status) => {
    useSettingsStore.setState({ modelRuntime: status });
  });
}
