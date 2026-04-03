# Contributing to Vaak

Thanks for your interest in contributing to Vaak! We're building a universal voice-to-text tool that works at the OS level, and we need help bringing it to Linux and Windows.

## How to contribute

1. **Fork** the repo and create a branch from `main`
2. **Make your changes** — follow the existing code patterns
3. **Test** your changes locally (`yarn dev`)
4. **Submit a PR** with a clear description of what you changed and why

## What we need help with

### High priority
- **Linux support** — audio recording (replace `rec`/SoX with PulseAudio/PipeWire), tray icon, global hotkeys, auto-paste (xdotool)
- **Windows support** — audio recording, system tray, global hotkeys, auto-paste (PowerShell/SendKeys)
- **Code signing** — help with macOS notarization and Windows signing

### Medium priority
- Improve Settings UI design
- Add more languages to the language picker
- Streaming transcription (start transcribing while still recording)
- Reduce DMG/installer size

### Nice to have
- Auto-update mechanism
- Homebrew cask formula
- Linux packaging (AppImage, .deb, Flatpak)
- Windows installer (NSIS, MSI)

## Architecture overview

```
src/
├── main/               # Electron main process (Node.js)
│   ├── index.ts        # App entry — tray, hotkeys, recording flow
│   ├── ipc.ts          # IPC handlers
│   └── services/       # Business logic
│       ├── audio.ts         # ← PLATFORM-SPECIFIC (currently macOS only)
│       ├── local-whisper.ts # whisper.cpp via worker thread
│       ├── cloud-whisper.ts # OpenAI-compatible API
│       ├── history.ts       # SQLite
│       ├── settings.ts      # JSON persistence
│       └── tray-icons.ts    # ← PLATFORM-SPECIFIC (SVG rendering)
├── preload/            # Context bridge
└── renderer/           # React frontend (platform-independent)
```

**Platform-specific files** that need attention for Linux/Windows:
- `audio.ts` — uses `rec` (SoX) for recording and `osascript` for auto-paste
- `tray-icons.ts` — uses macOS template images
- `index.ts` — uses `app.dock?.hide()` (macOS only), `osascript` for paste

## Code conventions

- **3-file split** for React features: `feature.hook.ts` / `feature.view.tsx` / `feature.tsx`
- **Zustand** for state management (one store per domain)
- **Services** have no Electron dependency where possible
- Keep it simple — no unnecessary abstractions

## Development setup

```bash
git clone https://github.com/narpatsinghpurohit/Vaak.git
cd Vaak
yarn install
npx electron-rebuild -f -w better-sqlite3

# macOS: install SoX for audio recording
brew install sox

# Run dev
yarn dev
```

## Platform-specific notes

### Linux contributors
- Audio: consider PulseAudio (`parecord`) or PipeWire (`pw-record`) instead of SoX `rec`
- Auto-paste: `xdotool key ctrl+v` or `xclip` + `xdotool`
- Tray: Electron's Tray works on Linux but template images don't — use regular PNGs
- Global hotkeys: Electron's `globalShortcut` works on X11, Wayland support varies

### Windows contributors
- Audio: consider `sox` (available via chocolatey) or native Windows audio APIs
- Auto-paste: PowerShell `Add-Type` + `SendKeys` or `nircmd`
- Tray: works out of the box
- Global hotkeys: works out of the box

## Submitting PRs

- Keep PRs focused — one feature or fix per PR
- Update the README if you add platform support
- Test on your platform before submitting
- Screenshots or terminal output in the PR description are appreciated

## Questions?

Open an issue or start a discussion on the repo. We're friendly.
