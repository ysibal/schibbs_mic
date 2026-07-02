const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("schibbsDesktop", {
  getInfo: () => ipcRenderer.invoke("desktop-info"),
  checkForUpdates: () => ipcRenderer.invoke("desktop-check-updates"),
  openDownloads: () => ipcRenderer.invoke("desktop-open-downloads"),
  onUpdateStatus: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener = (_event, status) => callback(status);
    ipcRenderer.on("desktop-update-status", listener);
    return () => ipcRenderer.removeListener("desktop-update-status", listener);
  }
});
