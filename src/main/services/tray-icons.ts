import { nativeImage, NativeImage, BrowserWindow } from "electron";
import { join } from "path";
import { existsSync } from "fs";

const OUTPUT_SIZE = 18;
const RENDER_SIZE = 36; // SVG viewBox for wave frames

let icons: {
  idle: NativeImage;
  recording: NativeImage[];    // 3 SVG-rendered wave frames
  transcribing: NativeImage[]; // 3 SVG-rendered typing frames
} | null = null;

function getAssetsDir(): string {
  const devPath = join(process.cwd(), "assets");
  if (existsSync(devPath)) return devPath;
  const prodPath = join(__dirname, "../../assets");
  if (existsSync(prodPath)) return prodPath;
  const resourcesPath = join(__dirname, "../../../assets");
  if (existsSync(resourcesPath)) return resourcesPath;
  return devPath;
}

function loadIcon(filename: string): NativeImage {
  const filepath = join(getAssetsDir(), filename);
  if (!existsSync(filepath)) {
    console.warn(`[tray-icons] Icon not found: ${filepath}`);
    return nativeImage.createEmpty();
  }
  const img = nativeImage.createFromPath(filepath);
  const resized = img.resize({ width: OUTPUT_SIZE, height: OUTPUT_SIZE });
  resized.setTemplateImage(true);
  return resized;
}


function waveSvg(frame: number): string {
  const v = RENDER_SIZE;
  const barW = 3.5;
  const gap = 2.5;
  const totalW = 7 * barW + 6 * gap;
  const startX = (v - totalW) / 2;

  const patterns = [
    [10, 20, 32, 24, 30, 16, 8],
    [14, 28, 24, 32, 22, 20, 12],
    [8, 16, 28, 20, 32, 24, 14],
  ];
  const heights = patterns[frame % 3];
  const centerY = v / 2;

  let bars = "";
  for (let i = 0; i < 7; i++) {
    const x = startX + i * (barW + gap);
    const h = heights[i];
    const y = centerY - h / 2;
    const r = barW / 2;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${r}" ry="${r}" fill="black"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v}" height="${v}" viewBox="0 0 ${v} ${v}">${bars}</svg>`;
}

function typingSvg(frame: number): string {
  const v = RENDER_SIZE;
  // Frame 0: "A" + cursor  |  Frame 1: "Aa" + cursor  |  Frame 2: "Aa" + cursor blink off
  const showA = true;
  const showSmallA = frame >= 1;
  const cursorOn = frame !== 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v}" height="${v}" viewBox="0 0 ${v} ${v}">
    <rect x="2" y="5" width="${v - 4}" height="${v - 10}" rx="4" ry="4"
          fill="none" stroke="black" stroke-width="2.5"/>
    ${showA ? `<text x="8" y="26" font-family="Helvetica,Arial,sans-serif" font-weight="bold"
          font-size="18" fill="black">A</text>` : ""}
    ${showSmallA ? `<text x="18" y="26" font-family="Helvetica,Arial,sans-serif" font-weight="normal"
          font-size="13" fill="black">a</text>` : ""}
    <rect x="${showSmallA ? 27 : 18}" y="10" width="2.5" height="16" rx="1" fill="black"
          opacity="${cursorOn ? 1 : 0}"/>
  </svg>`;
}

/** Render SVG frames (waves + typing) via hidden window */
async function renderAnimFrames(): Promise<{ waves: NativeImage[]; typing: NativeImage[] }> {
  const win = new BrowserWindow({
    width: RENDER_SIZE,
    height: RENDER_SIZE,
    show: false,
    webPreferences: { offscreen: true },
  });

  const html = `<!doctype html><html><body style="margin:0;background:transparent;">
    <canvas id="c" width="${RENDER_SIZE}" height="${RENDER_SIZE}"></canvas>
    <script>
      const canvas = document.getElementById("c");
      const ctx = canvas.getContext("2d");
      window.renderSvg = function(svgStr) {
        return new Promise((resolve) => {
          ctx.clearRect(0, 0, ${RENDER_SIZE}, ${RENDER_SIZE});
          const blob = new Blob([svgStr], { type: "image/svg+xml" });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, ${RENDER_SIZE}, ${RENDER_SIZE});
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL("image/png"));
          };
          img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
          img.src = url;
        });
      };
    </script>
  </body></html>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  async function render(svg: string): Promise<NativeImage> {
    const dataUrl = await win.webContents.executeJavaScript(
      `window.renderSvg(${JSON.stringify(svg)})`
    );
    if (dataUrl) {
      const raw = nativeImage.createFromDataURL(dataUrl);
      const img = raw.resize({ width: OUTPUT_SIZE, height: OUTPUT_SIZE });
      img.setTemplateImage(true);
      return img;
    }
    return nativeImage.createEmpty();
  }

  const waves = [await render(waveSvg(0)), await render(waveSvg(1)), await render(waveSvg(2))];
  const typing = [await render(typingSvg(0)), await render(typingSvg(1)), await render(typingSvg(2))];

  win.destroy();
  return { waves, typing };
}

/** Load icons — PNGs from assets, animated frames rendered from SVG */
export async function initTrayIcons(): Promise<void> {
  const { waves, typing } = await renderAnimFrames();
  icons = {
    idle: loadIcon("tray-idle.png"),
    recording: waves,
    transcribing: typing,
  };
  console.log("[tray-icons] Icons loaded");
}

export function getIdleIcon(): NativeImage {
  return icons?.idle ?? nativeImage.createEmpty();
}

// ── Animation controller ──

type AnimState = "idle" | "recording" | "transcribing";

let currentState: AnimState = "idle";
let animTimer: ReturnType<typeof setInterval> | null = null;
let animFrame = 0;
let trayRef: Electron.Tray | null = null;

export function setTrayRef(t: Electron.Tray): void {
  trayRef = t;
  applyIcon();
}

export function setTrayState(state: AnimState): void {
  if (state === currentState) return;
  currentState = state;
  animFrame = 0;

  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }

  applyIcon();

  if (state === "recording") {
    // Cycle wave frames
    animTimer = setInterval(() => {
      animFrame = (animFrame + 1) % 3;
      applyIcon();
    }, 350);
  } else if (state === "transcribing") {
    // Cycle typing frames
    animTimer = setInterval(() => {
      animFrame = (animFrame + 1) % 3;
      applyIcon();
    }, 500);
  }
}

function applyIcon(): void {
  if (!trayRef || !icons) return;

  switch (currentState) {
    case "recording":
      trayRef.setImage(icons.recording[animFrame % 3]);
      break;
    case "transcribing":
      trayRef.setImage(icons.transcribing[animFrame % 3]);
      break;
    default:
      trayRef.setImage(icons.idle);
  }
}
