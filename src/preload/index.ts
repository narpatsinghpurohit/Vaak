import { contextBridge, ipcRenderer } from "electron";

const api = {
  // Settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),

  // History
  queryHistory: (search?: string, limit?: number, offset?: number) =>
    ipcRenderer.invoke("history:query", search, limit, offset),
  deleteHistory: (id: number) => ipcRenderer.invoke("history:delete", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  togglePin: (id: number) => ipcRenderer.invoke("history:togglePin", id),
  getHistoryText: (id: number) => ipcRenderer.invoke("history:getText", id),

  // Models
  listModels: () => ipcRenderer.invoke("models:list"),
  downloadModel: (filename: string) => ipcRenderer.invoke("models:download", filename),
  cancelDownload: (filename: string) => ipcRenderer.invoke("models:cancel", filename),
  deleteModel: (filename: string) => ipcRenderer.invoke("models:delete", filename),
  getModelProgress: (filename: string) => ipcRenderer.invoke("models:getProgress", filename),

  // Accessibility (for auto-paste)
  checkAccessibility: () => ipcRenderer.invoke("accessibility:check") as Promise<boolean>,
  requestAccessibility: () => ipcRenderer.invoke("accessibility:request") as Promise<boolean>,

  // Events from main
  onDownloadProgress: (callback: (data: any) => void) => {
    const handler = (_e: any, data: any) => callback(data);
    ipcRenderer.on("models:downloadProgress", handler);
    return () => ipcRenderer.removeListener("models:downloadProgress", handler);
  },
  onDownloadComplete: (callback: (data: any) => void) => {
    const handler = (_e: any, data: any) => callback(data);
    ipcRenderer.on("models:downloadComplete", handler);
    return () => ipcRenderer.removeListener("models:downloadComplete", handler);
  },
  onDownloadError: (callback: (data: any) => void) => {
    const handler = (_e: any, data: any) => callback(data);
    ipcRenderer.on("models:downloadError", handler);
    return () => ipcRenderer.removeListener("models:downloadError", handler);
  },
};

contextBridge.exposeInMainWorld("voicePaste", api);

export type VoicePasteApi = typeof api;
