import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import {
  canOpenExternal,
  configPathFor,
  isExternalTarget,
  readDesktopConfig,
  requestedPort,
  resolveDataRoot,
  writeDesktopConfig,
} from './runtime-config.js';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let infoBoxServer = null;
let library = null;
let localOrigin = '';
let quitting = false;

function loadEnvironmentFile(path) {
  try { process.loadEnvFile(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function loadDesktopEnvironment(dataRoot) {
  const explicit = String(process.env.INFOBOX_ENV_FILE || '').trim();
  const candidates = explicit
    ? [resolve(explicit)]
    : [join(dataRoot, '.env'), join(app.getPath('userData'), '.env')];
  for (const path of candidates) {
    try {
      await access(path);
      loadEnvironmentFile(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function selectDataRoot(configPath, currentRoot) {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '选择 InfoBox 知识库目录',
    defaultPath: currentRoot,
    buttonLabel: '使用此目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (selection.canceled || !selection.filePaths[0]) return false;
  const nextRoot = resolve(selection.filePaths[0]);
  await writeDesktopConfig(configPath, { dataRoot: nextRoot });
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '知识库目录已更新',
    message: 'InfoBox 将重新启动并打开所选知识库。',
    detail: nextRoot,
    buttons: ['重新启动'],
  });
  if (answer.response === 0) {
    app.relaunch();
    app.exit(0);
  }
  return true;
}

async function chooseFirstRunRoot(configPath, defaultRoot) {
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '设置 InfoBox 知识库',
    message: '请选择 InfoBox 保存资料的位置。',
    detail: `可以选择现有 InfoBox 项目目录，也可以使用默认目录：\n${defaultRoot}`,
    buttons: ['选择文件夹', '使用默认目录'],
    defaultId: 0,
    cancelId: 1,
  });
  let dataRoot = defaultRoot;
  if (answer.response === 0) {
    const selection = await dialog.showOpenDialog({
      title: '选择 InfoBox 知识库目录',
      defaultPath: defaultRoot,
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!selection.canceled && selection.filePaths[0]) dataRoot = resolve(selection.filePaths[0]);
  }
  await writeDesktopConfig(configPath, { dataRoot });
  return dataRoot;
}

function configureWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isExternalTarget(url, localOrigin)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 980,
          height: 760,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (canOpenExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isExternalTarget(url, localOrigin)) return;
    event.preventDefault();
    if (canOpenExternal(url)) void shell.openExternal(url);
  });
  window.webContents.on('did-create-window', child => configureWindow(child));
}

function installMenu({ configPath, dataRoot }) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '切换知识库目录…', click: () => void selectDataRoot(configPath, dataRoot) },
        { type: 'separator' },
        { role: 'quit', label: '退出 InfoBox' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
  ]));
}

async function startService(dataRoot) {
  await loadDesktopEnvironment(dataRoot);
  const [{ Library }, { createApi }] = await Promise.all([
    import('../src/library.js'),
    import('../src/server.js'),
  ]);
  library = new Library({ root: dataRoot, vaultRoot: join(dataRoot, 'vault') });
  await library.init({ watchInbox: false, watchVault: true });
  infoBoxServer = createApi(library);
  await new Promise((resolveListen, reject) => {
    infoBoxServer.once('error', reject);
    infoBoxServer.listen(requestedPort(process.env.INFOBOX_PORT), '127.0.0.1', resolveListen);
  });
  const address = infoBoxServer.address();
  localOrigin = `http://127.0.0.1:${address.port}`;
}

async function stopService() {
  library?.close();
  if (!infoBoxServer?.listening) return;
  await new Promise(resolveClose => infoBoxServer.close(resolveClose));
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: 'InfoBox',
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f1e8',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  configureWindow(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(localOrigin);
}

async function boot() {
  app.setAppUserModelId('com.infobox.desktop');
  const configPath = configPathFor(app.getPath('userData'));
  const config = await readDesktopConfig(configPath);
  let selection = resolveDataRoot({
    environmentRoot: process.env.INFOBOX_DATA_DIR,
    configuredRoot: config.dataRoot,
    documentsPath: app.getPath('documents'),
  });
  if (selection.source === 'default') {
    const dataRoot = await chooseFirstRunRoot(configPath, selection.path);
    selection = { path: dataRoot, source: 'configured' };
  }
  await startService(selection.path);
  installMenu({ configPath, dataRoot: selection.path });
  await createMainWindow();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopService().finally(() => app.quit());
});

if (gotLock) {
  app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('InfoBox 启动失败', error?.message || String(error));
    app.exit(1);
  });
}
