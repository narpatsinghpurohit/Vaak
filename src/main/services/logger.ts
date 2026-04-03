import { appendFileSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const MAX_ENTRIES = 200;
let logs: string[] = [];
let logFile: string | null = null;

export function initLogger(appDir: string): void {
  logFile = join(appDir, "vaak.log");
  // Start fresh each launch
  writeFileSync(logFile, `--- Vaak started ${new Date().toISOString()} ---\n`);

  // Intercept console.log/warn/error
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    origLog(...args);
    addEntry("INFO", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    addEntry("WARN", args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    addEntry("ERR ", args);
  };
}

function addEntry(level: string, args: unknown[]): void {
  const time = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${time}] ${level} ${msg}`;

  logs.push(line);
  if (logs.length > MAX_ENTRIES) {
    logs = logs.slice(-MAX_ENTRIES);
  }

  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {}
  }
}

export function getLogs(): string[] {
  return [...logs];
}

export function getLogsText(): string {
  return logs.join("\n");
}

export function log(msg: string): void {
  console.log(msg);
}
