const { app, BrowserWindow, shell } = require("electron");
const { startServer } = require("../server");
const { hostedAppUrl } = require("./app-config.cjs");

let localServer;

function getHostedAppUrl() {
  const arg = process.argv.find((value) => value.startsWith("--hosted-url="));
  const configuredUrl = arg?.slice("--hosted-url=".length) || process.env.SCHIBBS_MIC_URL || hostedAppUrl;

  if (!configuredUrl) {
    return "";
  }

  try {
    const url = new URL(configuredUrl);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.toString();
    }
  } catch {
    return "";
  }

  return "";
}

async function getAppUrl() {
  const remoteUrl = getHostedAppUrl();
  if (remoteUrl) {
    return remoteUrl;
  }

  if (!localServer) {
    localServer = await startServer({ port: 0, host: "127.0.0.1", silent: true });
  }
  return localServer.url;
}

async function createWindow() {
  const appUrl = await getAppUrl();

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#111318",
    title: "schibb's mic",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(appUrl);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (localServer?.server) {
    localServer.server.close();
  }
});
