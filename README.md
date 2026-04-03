# Vaak (वाक्)

> *Sanskrit for "speech"* — your voice, instantly as text.

Vaak is a privacy-first macOS menu bar app that turns speech into text with a single hotkey. Press the shortcut, speak, and your words land on the clipboard — ready to paste anywhere. No cloud required.

## How it works

1. **Press** `Cmd+Shift+Space`
2. **Speak** naturally
3. **Press again** to stop — text is on your clipboard
4. **Paste** anywhere with `Cmd+V`

That's it. No windows to open, no apps to switch to.

## Features

- **Local-first** — runs whisper.cpp on your Mac's GPU via Metal. Your audio never leaves your machine.
- **Cloud option** — connect to Groq, OpenAI, or any OpenAI-compatible API for cloud transcription.
- **Model manager** — download and switch between Whisper models (tiny → large-v3-turbo) from Settings.
- **History** — every transcription is saved locally. Search, pin, copy, or clear from the history popup (`Cmd+Shift+H`).
- **Menu bar native** — lives in your tray with animated icons for idle, recording, and transcribing states.
- **Dark mode** — follows your system preference.

## Requirements

- macOS 12+
- [SoX](https://sox.sourceforge.net/) (`brew install sox`) — used for audio recording
- ~150 MB–1.5 GB disk space depending on which Whisper model you download

## Install

Download the latest `.dmg` from [Releases](https://github.com/narpatsinghpurohit/vaak/releases), open it, and drag Vaak to Applications.

Or build from source:

```bash
git clone https://github.com/narpatsinghpurohit/vaak.git
cd vaak
yarn install
npx electron-rebuild -f -w better-sqlite3
yarn build
yarn start
```

## Development

```bash
yarn dev        # starts vite dev server + tsc watch + electron
yarn build      # production build
yarn package    # build + create DMG
yarn typecheck  # type check without emitting
```

## Tech stack

| Layer | Tech |
|-------|------|
| Runtime | Electron 33 |
| Frontend | React 19, Zustand, Vite |
| Local STT | smart-whisper (whisper.cpp + Metal GPU) |
| Cloud STT | OpenAI-compatible API (Groq, OpenAI, etc.) |
| Database | better-sqlite3 (WAL mode) |
| Audio | SoX `rec` command |
| Packaging | electron-builder |

## Project structure

```
src/
├── main/               # Electron main process
│   ├── index.ts        # Tray, hotkeys, recording flow, windows
│   ├── ipc.ts          # IPC handlers (settings, history, models)
│   └── services/       # Business logic (no Electron deps where possible)
│       ├── audio.ts         # Record via SoX
│       ├── cloud-whisper.ts # OpenAI-compatible transcription
│       ├── local-whisper.ts # whisper.cpp via worker thread
│       ├── history.ts       # SQLite history
│       ├── model-manager.ts # Download/manage Whisper models
│       ├── settings.ts      # JSON settings persistence
│       ├── tray-icons.ts    # Animated tray icon system
│       ├── logger.ts        # In-app log viewer
│       └── types.ts         # Shared types
├── preload/index.ts    # Context bridge (IPC API)
└── renderer/           # React frontend
    ├── stores/         # Zustand stores
    └── features/       # 3-file split pattern (hook/view/glue)
        ├── settings/
        └── history/
```

## Privacy

- **Local mode**: Audio is recorded to a temp file, transcribed by whisper.cpp on your CPU/GPU, then deleted. Nothing is sent anywhere.
- **Cloud mode**: Audio is sent to the API endpoint you configure (Groq, OpenAI, etc.). Review their privacy policies.
- **History**: Stored in a local SQLite database in your app data directory. You can clear it anytime from the history popup.

## Platform support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Supported |
| macOS (Intel) | Untested — should work |
| Linux | Planned — contributors welcome |
| Windows | Planned — contributors welcome |

## Contributing

We'd love your help — especially for **Linux and Windows support**. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, platform-specific guidance, and how to get started.

## License

[MIT](LICENSE) — Narpat Singh, 2026.
