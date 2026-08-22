'use strict';

/**
 * App de mesa do PlingChat. Não é um app nativo separado — é o mesmo site de
 * produção (https://nexus67.vercel.app) dentro de uma janela sem barra de
 * endereço, abas ou menu de navegador. O backend continua sendo o Render;
 * esse processo não guarda nem processa nada por conta própria.
 */

const path = require('node:path');
const { app, BrowserWindow, Menu, session, desktopCapturer, ipcMain } = require('electron');

const NEXUS_URL = process.env.NEXUS_URL || 'https://nexus67.vercel.app';
const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadURL(NEXUS_URL);
  return win;
}

// Sem menu de app (File/Edit/View...) — o objetivo é parecer um app, nao um navegador.
Menu.setApplicationMenu(null);

/**
 * Escolhe qual tela/janela compartilhar. getDisplayMedia() do navegador nao
 * funciona sozinho no Electron — o processo principal precisa escolher a
 * fonte por ele. Abre uma janelinha com as opções (com miniatura) e devolve
 * a escolha; cancelar fecha sem compartilhar nada.
 */
function pickScreenSource() {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 640,
      height: 460,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Escolher tela ou janela',
      icon: ICON,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // precisa do preload com ipcRenderer
        preload: path.join(__dirname, 'picker', 'preload.js')
      }
    });
    picker.setMenuBarVisibility(false);
    picker.loadFile(path.join(__dirname, 'picker', 'index.html'));

    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('picker:choose', onChoose);
      if (!picker.isDestroyed()) picker.close();
      resolve(id);
    };
    const onChoose = (event, id) => { if (event.sender === picker.webContents) finish(id); };
    ipcMain.on('picker:choose', onChoose);
    picker.on('closed', () => finish(null));
  });
}

// Câmera e microfone: sem isso o Electron nega a permissão sem avisar nada.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (['media', 'camera', 'microphone', 'display-capture'].includes(permission)) return callback(true);
    callback(false);
  });

  ipcMain.handle('picker:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 300, height: 200 }
    });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const id = await pickScreenSource();
    if (!id) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const chosen = sources.find((s) => s.id === id);
    if (!chosen) return callback({});
    callback({ video: chosen, audio: 'loopback' });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
