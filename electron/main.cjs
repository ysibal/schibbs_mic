const path = require("path");
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } = require("electron");
const { startServer } = require("../server");
const { hostedAppUrl } = require("./app-config.cjs");

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  autoUpdater = null;
}

let localServer;
let mainWindow;
let currentAppUrl = "";
let updateStatus = {
  state: "idle",
  message: "updates idle",
  detail: ""
};

app.setAppUserModelId("com.schibbsmic.desktop");

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

function configurePermissions(appUrl) {
  const allowedOrigin = getUrlOrigin(appUrl);
  const appSession = session.defaultSession;
  const allowedPermissions = new Set(["media", "display-capture"]);

  appSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (!allowedPermissions.has(permission)) {
      callback(false);
      return;
    }

    const requestUrl = details.requestingUrl || webContents.getURL();
    callback(isAllowedOrigin(getUrlOrigin(requestUrl), allowedOrigin));
  });

  if (typeof appSession.setDisplayMediaRequestHandler === "function") {
    appSession.setDisplayMediaRequestHandler((request, callback) => {
      handleDisplayMediaRequest(request, callback, allowedOrigin);
    });
  }
}

async function handleDisplayMediaRequest(request, callback, allowedOrigin) {
  const requestOrigin = getDisplayMediaRequestOrigin(request);
  if (!isAllowedOrigin(requestOrigin, allowedOrigin)) {
    cancelDisplayMediaRequest(callback);
    return;
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 }
    });
    const source = await chooseDisplayMediaSource(sources);

    if (!source) {
      cancelDisplayMediaRequest(callback);
      return;
    }

    callback({ video: source });
  } catch (error) {
    console.error("display media request failed", error);
    cancelDisplayMediaRequest(callback);
  }
}

function getDisplayMediaRequestOrigin(request) {
  return getUrlOrigin(request?.securityOrigin) || getUrlOrigin(request?.frame?.url) || getUrlOrigin(currentAppUrl);
}

async function chooseDisplayMediaSource(sources) {
  if (!sources.length) {
    return null;
  }

  if (sources.length === 1 || !mainWindow) {
    return sources[0];
  }

  const choices = sources.slice(0, 10);
  const buttons = [...choices.map((source, index) => formatDisplaySourceName(source, index)), "cancel"];
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "share screen",
    message: "choose a screen to share",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true
  });

  return choices[result.response] || null;
}

function formatDisplaySourceName(source, index) {
  const name = String(source?.name || "").trim();
  return name ? name.toLowerCase() : `screen ${index + 1}`;
}

function cancelDisplayMediaRequest(callback) {
  callback({ video: null, audio: null });
}

function isAllowedOrigin(requestOrigin, allowedOrigin) {
  return Boolean(requestOrigin && allowedOrigin && requestOrigin === allowedOrigin);
}

function getUrlOrigin(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

async function createWindow() {
  const appUrl = await getAppUrl();
  currentAppUrl = appUrl;
  configurePermissions(appUrl);

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#20150f",
    title: "schibb's mic",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-fail-load", async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }

    await dialog.showMessageBox(win, {
      type: "error",
      title: "schibb's mic could not load",
      message: "the desktop app could not reach schibb's mic.",
      detail: `${errorDescription || "network error"} (${errorCode}).

check your internet connection or open ${validatedURL || currentAppUrl} in a browser.`
    });
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  await win.loadURL(appUrl);
}

function setupDesktopIpc() {
  ipcMain.handle("desktop-info", () => ({
    isDesktop: true,
    version: app.getVersion(),
    platform: process.platform,
    appUrl: currentAppUrl,
    updateStatus
  }));

  ipcMain.handle("desktop-open-downloads", () => {
    shell.openExternal("https://github.com/ysibal/schibbs_mic/releases/latest");
  });

  ipcMain.handle("desktop-check-updates", async () => checkForUpdates("manual"));
}

function publishUpdateStatus(state, message, detail = "") {
  updateStatus = { state, message, detail, checkedAt: Date.now() };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("desktop-update-status", updateStatus);
  }
}

async function checkForUpdates(reason = "scheduled") {
  if (!app.isPackaged) {
    publishUpdateStatus("development", "updates work after installing the packaged app.");
    return updateStatus;
  }

  if (!autoUpdater) {
    publishUpdateStatus("error", "updates are unavailable in this build.");
    return updateStatus;
  }

  try {
    if (reason === "manual") {
      publishUpdateStatus("checking", "checking for updates...");
    }
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateStatus("error", "update check failed.", getUpdateErrorDetail(error));
  }
  return updateStatus;
}

function setupAutoUpdates() {
  if (setupAutoUpdates.started) {
    return;
  }
  setupAutoUpdates.started = true;

  if (!app.isPackaged) {
    publishUpdateStatus("development", "updates work after installing the packaged app.");
    return;
  }

  if (!autoUpdater) {
    publishUpdateStatus("error", "updates are unavailable in this build.");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "ysibal",
    repo: "schibbs_mic"
  });

  autoUpdater.on("checking-for-update", () => {
    publishUpdateStatus("checking", "checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    publishUpdateStatus("available", "update found. downloading...", formatUpdateVersion(info));
  });

  autoUpdater.on("update-not-available", () => {
    publishUpdateStatus("current", "desktop app is up to date.");
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Number.isFinite(progress.percent) ? Math.round(progress.percent) : 0;
    publishUpdateStatus("downloading", `downloading update ${percent}%`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    publishUpdateStatus("ready", "update ready. restart to install.", formatUpdateVersion(info));

    const result = await dialog.showMessageBox(mainWindow || undefined, {
      type: "info",
      title: "schibb's mic update ready",
      message: "a new schibb's mic update is ready.",
      detail: `${formatUpdateVersion(info)}

restart the desktop app now to install it.`,
      buttons: ["restart and install", "later"],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on("error", (error) => {
    publishUpdateStatus("error", "update check failed.", getUpdateErrorDetail(error));
  });

  setTimeout(() => {
    checkForUpdates("startup");
  }, 6000);

  setInterval(() => {
    checkForUpdates("scheduled");
  }, 1000 * 60 * 60 * 6);
}

function formatUpdateVersion(info = {}) {
  return info.version ? `version ${info.version}` : "new version";
}

function getUpdateErrorDetail(error) {
  const message = String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim();
  if (/404|not found/i.test(message)) {
    return "release assets were not found. make sure the github release is public and includes latest.yml.";
  }
  if (/net|timeout|ENOTFOUND|ECONN/i.test(message)) {
    return "network connection failed while checking github releases.";
  }
  return message || "unknown update error.";
}

setupDesktopIpc();

app.whenReady().then(async () => {
  setupAutoUpdates();
  await createWindow();
});

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
