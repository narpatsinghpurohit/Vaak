import { execFile } from "child_process";
import { systemPreferences, Notification } from "electron";

// ── Append-only text insertion at the focused cursor ────────────────────────
//
// Used by streaming dictation to type each stabilized fragment into whatever app
// the user has focused. It only ever APPENDS — it never reaches back to edit text
// already on screen (we can't safely do that in an app we don't own).
//
// Phase 1 backend: `osascript … keystroke`. This is the SAME mechanism the batch
// auto-paste already relies on (System Events does the posting under Vaak's
// existing Accessibility grant), so it works in dev immediately with no new
// binary or permission. Because LocalAgreement commits in batches (~1 call/sec,
// not per keystroke), the per-call osascript spawn cost is negligible.
//
// Known limitation: System Events keystroke is keyboard-layout-sensitive (fine
// for Latin text on common layouts). The planned upgrade is a signed Swift
// CGEvent helper (CGEventKeyboardSetUnicodeString) which is layout-independent
// and clipboard-clean; it slots in behind this same `insertText` seam.

let warnedNoAccess = false;

/** Returns true if Vaak is a trusted Accessibility client; prompts once if not. */
export function ensureAccessibilityForInsertion(): boolean {
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted && !warnedNoAccess) {
    warnedNoAccess = true;
    systemPreferences.isTrustedAccessibilityClient(true); // opens System Settings
    new Notification({
      title: "Vaak — Accessibility Required",
      body: "Live dictation types into the focused app and needs Accessibility permission. Enable Vaak in System Settings → Privacy & Security → Accessibility, then try again.",
      silent: false,
    }).show();
  }
  return trusted;
}

// Serialize insertions so concatenated keystrokes never interleave or arrive
// out of order, even if commits land back-to-back.
let chain: Promise<void> = Promise.resolve();

function doInsert(text: string): Promise<void> {
  // Whisper word segments don't contain newlines; collapse any stray CR/LF so a
  // fragment can't accidentally submit a form mid-dictation.
  const clean = text.replace(/[\r\n]+/g, " ");
  if (!clean) return Promise.resolve();
  // AppleScript string escaping. We pass the script via execFile args (no shell),
  // so only backslash and double-quote need escaping; single quotes pass through.
  const escaped = clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "System Events" to keystroke "${escaped}"`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (err) => {
      if (err) console.error("[insert] keystroke failed:", err.message);
      resolve();
    });
  });
}

/** Queue a fragment to be typed at the focused cursor (append-only). */
export function insertText(text: string): Promise<void> {
  if (!text) return Promise.resolve();
  chain = chain.then(() => doInsert(text));
  return chain;
}
