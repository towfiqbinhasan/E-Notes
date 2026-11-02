// E-Notes desktop (Windows / Linux) - Electron main process.
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const isDev = process.argv.includes('--dev');
const DEV_URL = 'http://localhost:5173';
const DIST = path.join(__dirname, '..', 'dist');
const OAUTH_SCHEME = 'enotes';

let win = null;
let pendingDeepLink = null;
let pendingPdfFiles = [];

// The built app is served from app://enotes/ (a real origin: IndexedDB, workers and fetch all work).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---------- single instance + "enotes://" deep links (Google sign-in callback) ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    handleArgv(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(OAUTH_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(OAUTH_SCHEME);
}
app.on('open-url', (e, url) => { e.preventDefault(); sendDeepLink(url); });

function handleArgv(argv) {
  const link = argv.find((a) => a.startsWith(OAUTH_SCHEME + '://'));
  if (link) sendDeepLink(link);
  const pdfs = argv.filter((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
  if (pdfs.length) sendPdfFiles(pdfs);
}
function sendDeepLink(url) {
  if (win && !win.webContents.isLoading()) win.webContents.send('deep-link', url);
  else pendingDeepLink = url;
}
function sendPdfFiles(paths) {
  const files = paths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) }));
  if (win && !win.webContents.isLoading()) win.webContents.send('open-pdfs', files);
  else pendingPdfFiles.push(...files);
}

// ---------- window state persistence ----------

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // Make sure the saved position is still on a connected screen.
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x >= b.x - 50 && s.y >= b.y - 50 && s.x < b.x + b.width && s.y < b.y + b.height;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return { width: 1280, height: 860 };
  }
}
function saveWindowState() {
  if (!win) return;
  const b = win.getNormalBounds();
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* ignore */ }
}

// ---------- main window ----------

function createWindow() {
  const s = loadWindowState();
  win = new BrowserWindow({
    x: s.x, y: s.y, width: s.width || 1280, height: s.height || 860,
    minWidth: 420, minHeight: 500,
    show: false,
    title: 'E-Notes',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#f3f4f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  let saveTimer;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  // Dropping a file outside the drop zone must not navigate away from the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DEV_URL) && !url.startsWith('app://')) e.preventDefault();
  });
  // Links that open new windows (e.g. help) go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) { win.webContents.send('deep-link', pendingDeepLink); pendingDeepLink = null; }
    if (pendingPdfFiles.length) { win.webContents.send('open-pdfs', pendingPdfFiles); pendingPdfFiles = []; }
  });

  if (isDev) win.loadURL(DEV_URL);
  else win.loadURL('app://enotes/index.html');
}

// ---------- native menu ----------

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Notebook', accelerator: 'CmdOrCtrl+N', click: send('new-notebook') },
        { label: 'Import PDF…', accelerator: 'CmdOrCtrl+O', click: send('import-pdf') },
        { label: 'Add Blank Sheet', accelerator: 'CmdOrCtrl+Shift+N', click: send('add-sheet') },
        { type: 'separator' },
        { label: 'Export Notebook as PDF…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // registerAccelerator:false -> shortcut is shown but handled by the page (keeps text-box undo working)
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Pen', accelerator: 'P', registerAccelerator: false, click: send('tool:pen') },
        { label: 'Highlighter', accelerator: 'H', registerAccelerator: false, click: send('tool:highlighter') },
        { label: 'Eraser', accelerator: 'E', registerAccelerator: false, click: send('tool:eraser') },
        { label: 'Lasso Select', accelerator: 'L', registerAccelerator: false, click: send('tool:lasso') },
        { label: 'Text', accelerator: 'T', registerAccelerator: false, click: send('tool:text') },
        { label: 'Laser Pointer', accelerator: 'K', registerAccelerator: false, click: send('tool:laser') },
        { label: 'Hand (scroll)', accelerator: 'Space', registerAccelerator: false, click: send('tool:hand') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: send('zoom-reset') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('toggle-sidebar') },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+Shift+D', click: send('toggle-theme') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates', click: () => checkForUpdates(true) },
        { type: 'separator' },
        { label: 'About E-Notes', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'About E-Notes',
    message: `E-Notes ${app.getVersion()}`,
    detail:
      'A handwriting notebook for studying with PDFs. Write next to every page, ' +
      'sync live between Windows, Linux, Android and the web, and keep working offline.\n\n' +
      'Created by Md. Towfiq Bin Hasan and TH team.',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  });
}

// ---------- auto update (GitHub Releases) ----------

let updater = null;
let manualCheck = false;

function getUpdater() {
  if (updater) return updater;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = true;
  updater.on('update-not-available', () => {
    if (manualCheck) dialog.showMessageBox(win, { message: 'E-Notes is up to date.' });
  });
  updater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      message: `E-Notes ${info.version} is ready to install.`,
      detail: 'Restart the app to finish updating. Your notes are saved.',
    });
    if (response === 0) updater.quitAndInstall();
  });
  updater.on('error', (err) => {
    if (manualCheck) dialog.showErrorBox('Update failed', String(err && err.message ? err.message : err));
  });
  return updater;
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(win, { message: 'Updates are only checked in the installed app.' });
    return;
  }
  manualCheck = manual;
  getUpdater().checkForUpdates().catch(() => {});
}

// ---------- IPC from the renderer ----------

ipcMain.handle('save-file', async (_e, { name, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return filePath;
});
ipcMain.handle('open-external', (_e, url) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle('set-theme', (_e, theme) => {
  if (win) win.setBackgroundColor(theme === 'dark' ? '#0d0f15' : '#f3f4f9');
});

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  // Serve ./dist for app://enotes/...
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    return net.fetch(pathToFileURL(target).toString());
  });

  buildMenu();
  createWindow();
  handleArgv(process.argv);
  setTimeout(() => checkForUpdates(false), 5000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
