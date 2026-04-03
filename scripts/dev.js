const { spawn } = require("child_process");
const { createServer } = require("vite");
const path = require("path");

async function main() {
  // Start Vite dev server for renderer
  const vite = await createServer({
    configFile: path.join(__dirname, "../vite.config.ts"),
  });
  await vite.listen(5173);
  console.log("Renderer dev server: http://localhost:5173");

  // Compile main + preload with tsc (watch mode)
  const tsc = spawn("npx", ["tsc", "-p", "tsconfig.main.json", "--watch", "--preserveWatchOutput"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });

  // Wait a moment for initial compile
  await new Promise((r) => setTimeout(r, 2000));

  // Start Electron
  const electron = require("electron");
  const electronPath = typeof electron === "string" ? electron : electron.toString();
  const electronProc = spawn(electronPath, ["."], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://localhost:5173",
    },
  });

  electronProc.on("close", () => {
    tsc.kill();
    vite.close();
    process.exit();
  });
}

main().catch(console.error);
