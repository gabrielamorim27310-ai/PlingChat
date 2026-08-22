'use strict';

/**
 * App de mesa do nexus67. Não é um app nativo separado — é o mesmo site de
 * produção (https://nexus67.vercel.app) dentro de uma janela sem barra de
 * endereço, abas ou menu de navegador. O backend continua sendo o Render;
 * esse processo não guarda nem processa nada por conta própria.
 */

const { app, BrowserWindow, Menu, session, desktopCapturer } = require('electron');

const NEXUS_URL = process.env.NEXUS_URL || 'https://nexus67.vercel.app';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadURL(NEXUS_URL);
}

// Sem menu de app (File/Edit/View...) — o objetivo é parecer um app, nao um navegador.
Menu.setApplicationMenu(null);

// Câmera e microfone: sem isso o Electron nega a permissão sem avisar nada.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (['media', 'camera', 'microphone', 'display-capture'].includes(permission)) return callback(true);
    callback(false);
  });

  // Compartilhar tela: getDisplayMedia() do navegador nao funciona sozinho
  // no Electron, precisa que o processo principal escolha a fonte. Por ora
  // sempre oferece a tela principal — ainda nao dá pra escolher uma janela
  // específica (é a próxima melhoria, se fizer falta).
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
