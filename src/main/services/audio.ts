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
  return recordProcess !== null || streamProcess !== null;
}

// ── Streaming capture ──
// Unlike the batch path (write a WAV file, read it on stop), streaming pipes raw
// signed-16-bit-LE mono PCM from SoX's stdout and converts it to Float32 frames
// live. The two paths are independent; the batch functions above are untouched.

let streamProcess: ChildProcess | null = null;

/**
 * Start capturing the mic and deliver Float32 PCM (16 kHz mono, normalized to
 * [-1, 1]) to `onPcm` as it arrives. Returns once `rec` has been spawned.
 */
export function startStreamingRecording(onPcm: (pcm: Float32Array) => void): void {
  if (streamProcess) {
    console.warn("[audio] already streaming");
    return;
  }

  console.log("[audio] Spawning streaming: rec -r 16000 -c 1 -b 16 -t raw -e signed-integer -");

  streamProcess = spawn(
    "rec",
    ["-q", "-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-e", "signed-integer", "-"],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
      },
    },
  );

  console.log(`[audio] streaming rec PID: ${streamProcess.pid}`);

  // A 16-bit sample is 2 bytes; a stdout chunk can split a sample across its
  // boundary, so carry any trailing odd byte into the next chunk.
  let carry: Buffer | null = null;

  streamProcess.stdout?.on("data", (chunk: Buffer) => {
    let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    if (usable < buf.length) {
      carry = buf.subarray(usable);
      buf = buf.subarray(0, usable);
    } else {
      carry = null;
    }
    if (buf.length === 0) return;

    const n = buf.length / 2;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pcm[i] = buf.readInt16LE(i * 2) / 32768.0;
    }
    onPcm(pcm);
  });

  streamProcess.on("error", (err) => {
    console.error("[audio] streaming rec spawn error:", err.message);
    streamProcess = null;
  });

  streamProcess.on("exit", (code, signal) => {
    console.log(`[audio] streaming rec exited: code=${code} signal=${signal}`);
  });
}

/** Stop the streaming capture. Resolves once `rec` has exited. */
export async function stopStreamingRecording(): Promise<void> {
  if (!streamProcess) return;
  const proc = streamProcess;
  streamProcess = null;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // "close" (not "exit") fires after stdio streams have fully drained, so any
    // trailing PCM rec flushed on SIGINT is delivered before we resolve.
    proc.on("close", finish);
    proc.kill("SIGINT");
    // Safety: don't hang forever if close never fires.
    setTimeout(finish, 1000);
  });
}

export function isStreaming(): boolean {
  return streamProcess !== null;
}
