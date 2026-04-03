import { create } from "zustand";

interface HistoryState {
  entries: HistoryEntry[];
  search: string;
  selectedIndex: number;
  loaded: boolean;
  load: (search?: string) => Promise<void>;
  setSearch: (search: string) => void;
  deleteEntry: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
  togglePin: (id: number) => Promise<void>;
  copyEntry: (id: number) => Promise<void>;
  selectNext: () => void;
  selectPrev: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  search: "",
  selectedIndex: 0,
  loaded: false,

  load: async (search?: string) => {
    const entries = await window.voicePaste.queryHistory(search);
    set({ entries, loaded: true, selectedIndex: 0 });
  },

  setSearch: (search: string) => {
    set({ search });
    get().load(search);
  },

  deleteEntry: async (id: number) => {
    await window.voicePaste.deleteHistory(id);
    get().load(get().search);
  },

  clearAll: async () => {
    await window.voicePaste.clearHistory();
    set({ entries: [], selectedIndex: 0 });
  },

  togglePin: async (id: number) => {
    await window.voicePaste.togglePin(id);
    get().load(get().search);
  },

  copyEntry: async (id: number) => {
    const text = await window.voicePaste.getHistoryText(id);
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  },

  selectNext: () => {
    set((s) => ({
      selectedIndex: Math.min(s.selectedIndex + 1, s.entries.length - 1),
    }));
  },

  selectPrev: () => {
    set((s) => ({
      selectedIndex: Math.max(s.selectedIndex - 1, 0),
    }));
  },
}));
