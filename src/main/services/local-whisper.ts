import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import { Worker } from "worker_threads";
import { tmpdir } from "os";

let worker: Worker | null = null;
let workerReady = false;

function findSmartWhisper(): string {
  const candidates = [
    join(process.cwd(), "node_modules/smart-whisper"),
    join(__dirname, "../../node_modules/smart-whisper"),
    join(__dirname, "../../../node_modules/smart-whisper"),
  ];

  for (const c of candidates) {
    if (existsSync(join(c, "dist/index.js"))) {
      return c;
    }
  }

  try {
    const resolved = require.resolve("smart-whisper");
    return resolved.replace(/\/dist\/index\.js$/, "");
  } catch {}

  throw new Error("smart-whisper not found");
}

function makeWorkerCode(): string {
  const smartWhisperDir = findSmartWhisper();
  const metalShader = join(smartWhisperDir, "whisper.cpp/ggml/src/ggml-metal.metal");
  const hasShader = existsSync(metalShader);

  return `
const { parentPort } = require("worker_threads");
const { existsSync, copyFileSync } = require("fs");
const { join } = require("path");
const { Whisper } = require(${JSON.stringify(join(smartWhisperDir, "dist/index.js"))});

${hasShader ? `
const metalDest = join(process.cwd(), "ggml-metal.metal");
if (!existsSync(metalDest)) {
  try { copyFileSync(${JSON.stringify(metalShader)}, metalDest); } catch(e) {}
}
` : ""}

let whisper = null;
let loadedModel = null;

parentPort.on("message", async (msg) => {
  if (msg.type === "load") {
    try {
      if (whisper && loadedModel === msg.modelPath) {
        parentPort.postMessage({ type: "loaded" });
        return;
      }
      if (whisper) await whisper.free();
      console.log("[worker] Loading model:", msg.modelPath);
      whisper = new Whisper(msg.modelPath, { gpu: true });
      loadedModel = msg.modelPath;
      console.log("[worker] Model loaded in GPU memory");
      parentPort.postMessage({ type: "loaded" });
    } catch (err) {
      parentPort.postMessage({ type: "error", error: err.message });
    }
  }

  if (msg.type === "transcribe") {
    try {
      if (!whisper) {
        parentPort.postMessage({ type: "result", text: "", error: "Model not loaded" });
        return;
      }
      const wav = Buffer.from(msg.wavData);
      if (wav.length <= 44) { parentPort.postMessage({ type: "result", text: "" }); return; }

      const n = (wav.length - 44) / 2;
      const i16 = new Int16Array(wav.buffer, wav.byteOffset + 44, n);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = (i16[i] || 0) / 32768.0;

      if (pcm.length < 16000) { parentPort.postMessage({ type: "result", text: "" }); return; }

      const task = await whisper.transcribe(pcm, { language: msg.language === "auto" ? "auto" : msg.language });
      const segments = await task.result;
      const text = segments.map(s => s.text).join("").trim();
      parentPort.postMessage({ type: "result", text: text === "[BLANK_AUDIO]" ? "" : text });
    } catch (err) {
      parentPort.postMessage({ type: "result", text: "", error: err.message });
    }
  }
});
`;
}

function getWorker(): Worker {
  if (worker) return worker;

  const code = makeWorkerCode();
  const workerPath = join(tmpdir(), "vaak-whisper-worker.js");
  writeFileSync(workerPath, code);

  worker = new Worker(workerPath);

  worker.on("error", (err: Error) => {
    console.error("[whisper-worker] error:", err.message);
    worker = null;
    workerReady = false;
  });

  worker.on("exit", (code) => {
    if (code !== 0) console.error("[whisper-worker] crashed:", code);
    worker = null;
    workerReady = false;
  });

  return worker;
}

export function preloadModel(modelsDir: string, modelId: string): void {
  const modelPath = join(modelsDir, modelId);
  if (!existsSync(modelPath)) {
    console.warn("Model not found:", modelPath);
    return;
  }

  const w = getWorker();
  w.postMessage({ type: "load", modelPath });

  const handler = (msg: { type: string; error?: string }) => {
    if (msg.type === "loaded") {
      workerReady = true;
      w.removeListener("message", handler);
    } else if (msg.type === "error") {
      console.error("Model load failed:", msg.error);
      w.removeListener("message", handler);
    }
  };
  w.on("message", handler);
}

export function transcribeLocal(
  wavBuffer: Buffer,
  modelsDir: string,
  modelId: string,
  language: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = getWorker();

    const sendTranscribe = () => {
      w.postMessage({
        type: "transcribe",
        wavData: wavBuffer.buffer.slice(
          wavBuffer.byteOffset,
          wavBuffer.byteOffset + wavBuffer.byteLength,
        ),
        language,
      });
    };

    const handler = (msg: { type: string; text?: string; error?: string }) => {
      if (msg.type === "loaded") {
        workerReady = true;
        sendTranscribe();
      } else if (msg.type === "result") {
        w.removeListener("message", handler);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.text ?? "");
      } else if (msg.type === "error") {
        w.removeListener("message", handler);
        reject(new Error(msg.error ?? "Worker error"));
      }
    };

    w.on("message", handler);

    if (workerReady) {
      sendTranscribe();
    } else {
      w.postMessage({ type: "load", modelPath: join(modelsDir, modelId) });
    }
  });
}
