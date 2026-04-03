import { spawn, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, unlinkSync, existsSync } from "fs";

let recordProcess: ChildProcess | null = null;
let recordingPath: string | null = null;
let recordingStartTime: number = 0;

export function startRecording(): void {
  if (recordProcess) {
    console.warn("Already recording");
    return;
  }

  const filename = `vaak-${Date.now()}.wav`;
  recordingPath = join(tmpdir(), filename);
  recordingStartTime = Date.now();

  console.log(`[audio] Spawning: rec -r 16000 -c 1 -b 16 ${recordingPath}`);
  console.log(`[audio] PATH: ${process.env.PATH}`);

  recordProcess = spawn("rec", ["-r", "16000", "-c", "1", "-b", "16", recordingPath], {
    stdio: "ignore",
    env: {
      ...process.env,
      // Ensure /opt/homebrew/bin and /usr/local/bin are in PATH for packaged app
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
    },
  });

  console.log(`[audio] rec PID: ${recordProcess.pid}`);

  recordProcess.on("error", (err) => {
    console.error("[audio] rec spawn error:", err.message);
    recordProcess = null;
    recordingPath = null;
  });

  recordProcess.on("exit", (code, signal) => {
    console.log(`[audio] rec exited: code=${code} signal=${signal}`);
  });

  console.log("[audio] Recording started:", recordingPath);
}

export async function stopRecording(): Promise<{ wavBuffer: Buffer; durationSecs: number }> {
  console.log(`[audio] stopRecording called — process=${!!recordProcess} path=${recordingPath}`);

  if (!recordProcess || !recordingPath) {
    throw new Error("Not recording — no process or path");
  }

  const path = recordingPath;
  const startTime = recordingStartTime;
  const proc = recordProcess;

  recordProcess = null;
  recordingPath = null;

  console.log(`[audio] Sending SIGINT to rec PID ${proc.pid}...`);
  // Send SIGINT to rec to stop cleanly (finalizes WAV header)
  await new Promise<void>((resolve) => {
    proc.on("exit", (code, signal) => {
      console.log(`[audio] rec stopped: code=${code} signal=${signal}`);
      resolve();
    });
    proc.kill("SIGINT");
  });

  // Small delay to let the file be finalized
  await new Promise((r) => setTimeout(r, 200));

  console.log(`[audio] Checking file: ${path} exists=${existsSync(path)}`);
  if (!existsSync(path)) {
    throw new Error(`Recording file not found: ${path}`);
  }

  const wavBuffer = Buffer.from(readFileSync(path));
  const durationSecs = (Date.now() - startTime) / 1000;

  try {
    unlinkSync(path);
  } catch {}

  console.log(`[audio] Recording stopped: ${durationSecs.toFixed(1)}s, ${wavBuffer.length} bytes`);
  return { wavBuffer, durationSecs };
}

export function isRecording(): boolean {
  return recordProcess !== null;
}
