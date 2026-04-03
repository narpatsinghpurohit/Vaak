import { existsSync, unlinkSync, createWriteStream, renameSync } from "fs";
import { join } from "path";

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export interface ModelDef {
  id: string;
  filename: string;
  displayName: string;
  sizeBytes: number;
  sizeDisplay: string;
  description: string;
  recommended: boolean;
}

export const MODEL_CATALOG: ModelDef[] = [
  // English-only models
  { id: "tiny.en", filename: "ggml-tiny.en.bin", displayName: "Tiny EN", sizeBytes: 77_691_713, sizeDisplay: "75 MB", description: "Fastest, lowest accuracy", recommended: false },
  { id: "base.en", filename: "ggml-base.en.bin", displayName: "Base EN", sizeBytes: 147_951_465, sizeDisplay: "141 MB", description: "Good for clear speech", recommended: false },
  { id: "small.en", filename: "ggml-small.en.bin", displayName: "Small EN", sizeBytes: 487_601_967, sizeDisplay: "466 MB", description: "Great balance", recommended: true },
  { id: "medium.en", filename: "ggml-medium.en.bin", displayName: "Medium EN", sizeBytes: 1_533_774_781, sizeDisplay: "1.5 GB", description: "High accuracy", recommended: false },
  // Large v3 — best multilingual model
  { id: "large-v3", filename: "ggml-large-v3.bin", displayName: "Large v3", sizeBytes: 3_095_033_483, sizeDisplay: "2.9 GB", description: "Best multilingual, full precision", recommended: false },
  { id: "large-v3-q5_0", filename: "ggml-large-v3-q5_0.bin", displayName: "Large v3 Q5", sizeBytes: 1_080_000_000, sizeDisplay: "1.0 GB", description: "Best multilingual, quantized", recommended: false },
  // Large v3 Turbo — fastest large model
  { id: "large-v3-turbo", filename: "ggml-large-v3-turbo.bin", displayName: "Large v3 Turbo", sizeBytes: 1_620_000_000, sizeDisplay: "1.5 GB", description: "Fast + accurate, full precision", recommended: false },
  { id: "large-v3-turbo-q5_0", filename: "ggml-large-v3-turbo-q5_0.bin", displayName: "Large v3 Turbo Q5", sizeBytes: 574_000_000, sizeDisplay: "547 MB", description: "Fast + accurate, quantized", recommended: true },
];

export interface ModelStatus {
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

export function getModelStatuses(modelsDir: string): ModelStatus[] {
  return MODEL_CATALOG.map((m) => {
    const filePath = join(modelsDir, m.filename);
    const downloaded = existsSync(filePath);
    return {
      id: m.id,
      filename: m.filename,
      displayName: m.displayName,
      sizeDisplay: m.sizeDisplay,
      description: m.description,
      recommended: m.recommended,
      downloaded,
      downloadedBytes: 0,
      totalBytes: m.sizeBytes,
    };
  });
}

const activeDownloads = new Map<string, AbortController>();
const downloadProgress = new Map<string, { downloaded: number; total: number; speed: number }>();

export function getDownloadProgress(filename: string) {
  return downloadProgress.get(filename) ?? null;
}

export async function downloadModel(
  modelsDir: string,
  filename: string,
  onProgress: (downloaded: number, total: number, speed: number) => void,
): Promise<void> {
  const url = `${HF_BASE}/${filename}`;
  const destPath = join(modelsDir, filename);
  const tmpPath = destPath + ".tmp";

  const controller = new AbortController();
  activeDownloads.set(filename, controller);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const total = parseInt(response.headers.get("content-length") || "0", 10);
    let downloaded = 0;
    const startTime = Date.now();

    const writer = createWriteStream(tmpPath);
    const reader = response.body!.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      writer.write(Buffer.from(value));
      downloaded += value.length;

      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0.5 ? downloaded / elapsed : 0;
      downloadProgress.set(filename, { downloaded, total, speed });
      onProgress(downloaded, total, speed);
    }

    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.on("error", reject);
    });

    renameSync(tmpPath, destPath);
    console.log(`Model downloaded: ${filename}`);
  } finally {
    activeDownloads.delete(filename);
    downloadProgress.delete(filename);
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch {}
    }
  }
}

export function cancelDownload(filename: string): void {
  const controller = activeDownloads.get(filename);
  if (controller) {
    controller.abort();
    activeDownloads.delete(filename);
    downloadProgress.delete(filename);
  }
}

export function deleteModel(modelsDir: string, filename: string): void {
  const filePath = join(modelsDir, filename);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    console.log(`Model deleted: ${filename}`);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatSpeed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}
