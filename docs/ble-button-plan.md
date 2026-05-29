# Vaak — Bluetooth Push-to-Talk Button (Personal Prototype)

## Context

Vaak is a shipped, open-source macOS menu-bar app (v0.2.8, Electron 33) that turns speech to
text: press `Cmd+Shift+Space`, speak, and the transcription (local whisper.cpp/Metal or cloud)
lands on the clipboard and auto-pastes at the cursor. The original project vision was always a
**physical Bluetooth device** — only the host software was ever built.

This plan productizes the device as a **personal prototype first**: build *one* great unit with
off-the-shelf parts to prove the magic, then decide commercialization later. Per the design
decisions made this session:

- **Trigger-only** (no mic in the device) — uses the Mac's own mic / paired AirPods.
- **Distinct primary + tiny secondary button** (primary = record; secondary reserved for a
  future command/edit mode).
- The hero interaction: **hold → speak → release → pasted where the cursor is.**

The research below confirms trigger-only is not just simpler — on macOS in 2026 it is the
*correct* call: macOS has **no LE Audio / LC3 mic input** and a Bluetooth mic falls back to
HFP 16 kHz narrowband (how AirPods do it — degraded). An in-device mic adds cost for quality
Whisper doesn't need. A BLE HID button sidesteps the entire audio-transport problem.

## The product (how I'd design it — Apple product-engineer lens)

A small **palm puck** that lives on a desk and nests in the hand. Everything serves one moment:
you have a thought, hold the button, speak, let go, and the words are *there*.

**Keep:**
- **One hero button** — a 12 mm tactile dome under the whole top surface, with a deliberate,
  satisfying click. Eyes-free; you should never look at it.
- **Hold-to-talk** — press starts recording, release stops *and* pastes. One physical motion =
  one transcribed thought, placed.
- **A tiny recessed secondary button** — reserved for **command/edit mode** later ("make that a
  bullet list"). For the prototype it maps to an existing useful action (open History,
  `Cmd+Shift+H`).
- **A single status LED** — breathing = ready, solid = recording. Ambient, not a dashboard.
- **USB-C charging**, small LiPo, weeks of standby (Nordic-class power — the eventual nRF52840
  build; the ESP32 prototype is USB/desk-powered).

**Kill (subtract):** no screen, no button farm, no on-device settings, no speaker. It's an input
instrument.

**Why it beats "just AirPods + a hotkey":** tactile eyes-free certainty (push-to-talk works
because your body *knows* it's live), always-ready/always-charged, no reaching to the laptop
keyboard, and a genuine accessibility/RSI win (the keyboard *chord* is the pain point). Honest
caveat: for mainstream desk workers, AirPods + Wispr-style hotkey is "good enough" — the wedge is
**RSI/accessibility users and voice-coding devs** (Talon/Cursorless/Plover communities, who are
hardware-friendly buyers).

## Architecture decision — the key insight

**MVP = pure BLE HID keyboard. Zero changes to Vaak.**

Vaak already gives us the exact seam a HID button needs:
- `registerHotkeys()` registers `CommandOrControl+Shift+Space` → `toggleRecording()`
  — [src/main/index.ts:153](../src/main/index.ts#L153-L165)
- `toggleRecording()` start/stop/transcribe/clipboard/paste loop
  — [src/main/index.ts:197](../src/main/index.ts#L197-L276)
- `simulatePaste()` = `osascript` Cmd+V, gated on `isTrustedAccessibilityClient`
  — [src/main/index.ts:169](../src/main/index.ts#L169-L193)
- Recording is `rec -r 16000 -c 1 -b 16` (SoX) on the **system default input** — no device
  selection — [src/main/services/audio.ts:23](../src/main/services/audio.ts#L23)
- `Settings.autoPaste` already exists — [src/main/services/types.ts](../src/main/services/types.ts)

So the device firmware just emits keystrokes the OS already understands:

```
Primary button DOWN  → send Cmd+Shift+Space   (Vaak starts recording)
Primary button UP    → send Cmd+Shift+Space   (Vaak stops → transcribes → auto-pastes at cursor)
Secondary button tap → send Cmd+Shift+H        (open History; reserved for command-mode later)
```

The firmware translates one physical hold into two toggle events at the press/release edges → the
user experiences **true hold-to-talk** even though Vaak only knows its existing toggle hotkey.
Driver-free (HID-over-GATT is native on macOS), lowest latency (HID gets ~11 ms connection
interval), native pairing + auto-reconnect on wake, **no native module, no new permission prompt**
(Accessibility is already required for auto-paste today).

Prerequisite, no code: in Vaak Settings enable **Auto-paste**, and confirm Accessibility
permission. That's it — the MVP is a hardware + firmware exercise.

## MVP build (do this first)

**Bill of materials (~$25–40, one unit):**

| Part | Choice | ~Cost |
|------|--------|------|
| MCU | **ESP32 dev board** (classic dual-core, e.g. ESP32 DevKitC / WROOM-32) — Bluetooth built in, no separate module; best-tested with the `ESP32-BLE-Keyboard` library. Use a *classic* ESP32, not S3/C3, for the simplest library path. | ~$6 |
| Primary switch | **Omron B3F-1000** 12 mm tactile (+ a domed cap) | ~$1 |
| Secondary switch | 6 mm Alps/Omron tactile | ~$0.5 |
| Status LED | single NeoPixel or plain LED + resistor | ~$1 |
| Power | USB power for the desk prototype; or a LiPo (≥500 mAh, ESP32 is power-hungry) + TP4056 charger | ~$0–10 |
| Enclosure | 3D-printed palm puck **or** small round project box | ~$5–10 |
| Misc | protoboard, wire | ~$5 |

MCU rationale: chosen for the **simplest Arduino code** — `ESP32-BLE-Keyboard` makes the chip a
BLE HID keyboard in ~10 lines, and BT is on-chip. Trade-off: ESP32 draws ~10× more idle current
than a Nordic nRF52840, so the *battery* story is weak — fine for a USB-powered desk puck. If/when
we want a pocketable, weeks-of-standby unit, the upgrade is an **nRF52840** board (XIAO nRF52840 /
Adafruit Feather nRF52840 / Arduino Nano 33 BLE) via the Adafruit nRF52 Arduino core — same HID
approach, identical from Vaak's side.

**Firmware (Arduino IDE + `ESP32-BLE-Keyboard` library):**
- Advertise as a BLE HID keyboard (`BleKeyboard kb("Vaak", "Vaak", 100);`).
- Debounce both buttons (~15 ms). Treat the primary **press edge** and **release edge** as two
  distinct events; send the `Cmd+Shift+Space` chord (`KEY_LEFT_GUI`+`KEY_LEFT_SHIFT`+`' '`) on each.
- Secondary tap → `Cmd+Shift+H` (History; reserved for command-mode later).
- LED: solid while the primary button is physically held (self-indicated; no app channel needed
  for MVP).

```cpp
#include <BleKeyboard.h>
BleKeyboard kb("Vaak", "Vaak", 100);
const int REC = 4, CMD = 5;           // buttons to GND (INPUT_PULLUP)
bool recHeld = false, cmdHeld = false;

void chord(char k){                   // Cmd+Shift+k
  kb.press(KEY_LEFT_GUI); kb.press(KEY_LEFT_SHIFT); kb.press(k);
  delay(20); kb.releaseAll();
}
void setup(){ pinMode(REC,INPUT_PULLUP); pinMode(CMD,INPUT_PULLUP); kb.begin(); }
void loop(){
  if(!kb.isConnected()){ delay(50); return; }
  bool rec = digitalRead(REC)==LOW;             // add real debounce
  if(rec && !recHeld){ chord(' '); recHeld=true; }   // press   -> start recording
  if(!rec && recHeld){ chord(' '); recHeld=false; }  // release -> stop + auto-paste
  bool cmd = digitalRead(CMD)==LOW;
  if(cmd && !cmdHeld){ chord('h'); cmdHeld=true; }    // tap     -> History
  if(!cmd) cmdHeld=false;
  delay(10);
}
```

**Enclosure:** palm-sized puck, primary button is the domed top, secondary recessed on the side,
USB-C accessible for charging.

## Roadmap

- **Phase 0 — Magic check (this week):** ESP32 + one tactile button on a breadboard, flash the
  `ESP32-BLE-Keyboard` firmware, pair to the Mac, enable Vaak auto-paste. Validate
  hold→speak→release→paste end-to-end (USB-powered is fine). No enclosure yet.
- **Phase 1 — The puck:** add LED + secondary button (+ optional LiPo), 3D-print the palm puck,
  dogfood for a couple of weeks. This is the "one great unit." If battery life matters here,
  swap the ESP32 for an nRF52840 board (same firmware approach).
- **Phase 2 (optional) — True app-coupled feedback:** if you want the LED to reflect Vaak's *real*
  state (recording/transcribing) and genuine press/release semantics independent of the toggle,
  add the **hybrid (HID + custom GATT)** path:
  - Extract a `RecordingController` EventEmitter (`start()/stop()/toggle()`) from
    [src/main/services/audio.ts](../src/main/services/audio.ts) so hotkey, IPC, and BLE are peer
    consumers.
  - Add `src/main/services/ble-device.ts` using **@abandonware/noble** in the main process
    (`@electron/rebuild` is already a devDependency) to subscribe to a custom GATT characteristic
    (press=0x01 / release=0x00) → `controller.start()` / `controller.stop()`.
  - App writes state back to a GATT characteristic to drive the device LED; firmware reports
    battery.
  - Adds `NSBluetoothAlwaysUsageDescription` to Info.plist + a Bluetooth privacy prompt, and a
    reconnect-on-wake state machine (noble's known weak spot). Keep the HID paste/secondary key as
    a pure-HID fallback that works even if the app/GATT link is down.
- **Phase 3 (only if it earns it) — Small batch / open hardware:** pre-certified **Raytac
  MDBT50Q-1MV2 (nRF52840)** module (inherits FCC/CE/IC; cert reduces to a BT-SIG Declaration
  ~$4–8k vs $15–50k custom radio), custom PCB, sell assembled units + publish designs via **Crowd
  Supply** (OSHWA path). Software stays free/OSS — monetize the convenience, not the bits.

## Risks

- **Press-and-hold via pure HID has one limit** we're sidestepping correctly: Electron
  `globalShortcut` fires once with no key-up and held keys auto-repeat — so we do *not* hold a HID
  key down; the firmware sends discrete chords on the press/release edges. (If we ever route the
  hotkey through a global key monitor instead, revisit.)
- **Post-wake reconnect:** non-Apple BLE devices can take up to ~5 s to re-attach after lid-open;
  the first press may drop — firmware should retry/buffer.
- **Custom/consumer keycodes can collide** with macOS media keys — using the standard
  `Cmd+Shift+Space`/`Cmd+Shift+H` chords avoids this.
- **Phase 2 native-module burden:** noble must be rebuilt per Electron ABI and has reconnect
  churn; this repo already carries a fragile smart-whisper native patch, so budget for it. Not
  needed for the MVP.
- **State desync** if the real keyboard hotkey and the button are both used — harmless for a
  personal prototype.

## Verification (end-to-end)

1. Pair the device in macOS System Settings → Bluetooth (appears as a keyboard).
2. In Vaak Settings: enable **Auto-paste**; confirm Vaak has Accessibility permission.
3. In any text field: **hold** the primary button, say a sentence, **release** → transcription
   should paste at the cursor within Vaak's normal transcription latency (~1–2 s local).
4. Tap the secondary button → History window opens (`Cmd+Shift+H`).
5. Latency sanity: press-to-record-start should feel instant (<~50 ms). Verify reconnect after
   closing/opening the lid.
6. (Phase 2) Confirm the LED tracks Vaak's recording/transcribing state and that paste still works
   if Vaak is quit (pure-HID key) — proving graceful degradation.

## Out of scope (this prototype)

In-device microphone / wireless audio streaming, manufacturing/PCB/injection molding, FCC/CE/
BT-SIG certification, iOS/cross-platform, and any Vaak transcription/model changes.
