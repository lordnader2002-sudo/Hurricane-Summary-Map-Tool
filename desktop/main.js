/*
 * Electron shell for the Hurricane Map Tool.
 *
 * Deliberately minimal: one BrowserWindow loading the same static
 * index.html that GitHub Pages serves. No preload, no IPC, no auto-update —
 * nothing an analyst-maintained fork has to babysit. The web app already
 * handles offline (bundled basemap + ZIP geocoding), so the shell's only
 * jobs are: a double-clickable exe, a native window, and working downloads.
 */
'use strict';

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function appIndexPath() {
  // Packaged: electron-builder copies the web app into resources/app-web
  // (see extraResources in package.json). Dev (`npx electron .`): use the
  // repo checkout one directory up.
  const packaged = path.join(process.resourcesPath || '', 'app-web', 'index.html');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'index.html');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Hurricane Map Tool',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links (OSM attribution, NHC) open in the system browser, not
  // inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(appIndexPath());
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
