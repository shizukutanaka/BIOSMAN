// BIOSMAN desktop shell (Electron)
// Loads the self-contained BIOSMAN index.html in its own window.
// App data (the board registry) lives in the page's localStorage, which
// Electron persists in this app's own user-data folder on the PC:
//   Windows: %APPDATA%\BIOSMAN
// Nothing is written to the registry and there is no installer.
const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow, shell, Menu, ipcMain, net, Notification } = require('electron');

app.setName('BIOSMAN');

/* ---------------- PC bridge (window.biosmanPC via preload) ----------------
   Read-only by design: the bridge never writes to USB drives or anywhere
   else. Every handler fails soft — it resolves with an empty result plus
   a reason instead of throwing, so the app can never crash on a scan. */

// PowerShell script (Windows only): enumerate removable drives
// (Win32_LogicalDisk DriveType=2) and list BIOS-like files in each
// drive's root and first level of subfolders. Outputs JSON on stdout.
// BIOS-like = known firmware extensions, Gigabyte-style ".F12" version
// extensions, or MSI/ASRock-style model file names (letter + digits,
// with no extension or a short numeric one).
const SCAN_PS = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$exts = @('.cap','.rom','.bin','.efi','.fd','.bio','.hdr','.wph')
function Is-BiosFile($f) {
  $ext = $f.Extension.ToLower()
  if ($exts -contains $ext) { return $true }
  if ($ext -match '^\\.[a-z]?[0-9]{1,3}[a-z0-9]?$') { return $true }
  if (($ext -eq '' -or $ext -match '^\\.[0-9a-z]{1,4}$') -and
      $f.BaseName -match '^[A-Za-z][A-Za-z0-9_-]{4,}$' -and
      $f.BaseName -match '[0-9]') { return $true }
  return $false
}
$found = @()
$drives = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2"
foreach ($d in $drives) {
  $root = $d.DeviceID + '\\'
  $files = @()
  $files += Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue
  $files += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -File -ErrorAction SilentlyContinue }
  foreach ($f in $files) {
    if (Is-BiosFile $f) {
      $found += [PSCustomObject]@{
        drive = $d.DeviceID
        path  = $f.FullName
        name  = $f.Name
        size  = $f.Length
        mtime = $f.LastWriteTimeUtc.ToString('o')
      }
    }
  }
}
$found | ConvertTo-Json -Compress
`;

function scanUSB() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ files: [], error: 'unsupported-platform: ' + process.platform });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCAN_PS],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ files: [], error: 'powershell-failed: ' + err.message });
          return;
        }
        try {
          const text = String(stdout || '').trim();
          if (!text) { resolve({ files: [], error: null }); return; }
          const parsed = JSON.parse(text);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const files = list.map((f) => ({
            drive: String(f.drive || ''),
            path: String(f.path || ''),
            name: String(f.name || ''),
            size: Number(f.size) || 0,
            mtime: String(f.mtime || ''),
          }));
          resolve({ files, error: null });
        } catch (e) {
          resolve({ files: [], error: 'parse-failed: ' + e.message });
        }
      }
    );
  });
}

function fetchText(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      resolve({ ok: false, status: 0, text: '', error: 'invalid-url' });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolve({ ok: false, status: 0, text: '', error: 'unsupported-protocol' });
      return;
    }
    const MAX_BYTES = 4 * 1024 * 1024;
    const follow = (currentUrl, redirects) => {
      const req = net.request({ method: 'GET', url: currentUrl, redirect: 'manual' });
      req.setHeader('User-Agent', 'BIOSMAN/' + app.getVersion());
      req.setHeader('Accept', 'text/html,application/xhtml+xml,*/*');
      const timer = setTimeout(() => { try { req.abort(); } catch (e) {} }, 25000);
      req.on('response', (res) => {
        const status = res.statusCode || 0;
        const location = res.headers && (res.headers.location || res.headers.Location);
        if (status >= 300 && status < 400 && location) {
          clearTimeout(timer);
          res.on('data', () => {});
          res.on('end', () => {
            if (redirects >= 5) {
              resolve({ ok: false, status, text: '', error: 'too-many-redirects' });
              return;
            }
            let next;
            try { next = new URL(location, currentUrl).toString(); }
            catch (e) { resolve({ ok: false, status, text: '', error: 'bad-redirect' }); return; }
            follow(next, redirects + 1);
          });
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received <= MAX_BYTES) chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: status >= 200 && status < 300, status, text, error: status >= 200 && status < 300 ? null : 'http-' + status });
        });
        res.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, status, text: '', error: 'response-error: ' + e.message }); });
      });
      req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, status: 0, text: '', error: 'request-error: ' + e.message }); });
      req.end();
    };
    follow(parsed.toString(), 0);
  });
}

function registerBridge() {
  ipcMain.handle('biosman:scanUSB', async () => {
    try { return await scanUSB(); }
    catch (e) { return { files: [], error: 'scan-failed: ' + e.message }; }
  });
  ipcMain.handle('biosman:fetchText', async (_event, url) => {
    try { return await fetchText(url); }
    catch (e) { return { ok: false, status: 0, text: '', error: 'fetch-failed: ' + e.message }; }
  });
  ipcMain.handle('biosman:notify', async (_event, payload) => {
    try {
      if (!Notification.isSupported()) return { ok: false, error: 'notifications-unsupported' };
      const n = new Notification({ title: (payload && payload.title) || 'BIOSMAN', body: (payload && payload.body) || '' });
      n.show();
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: 'notify-failed: ' + e.message };
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    title: 'BIOSMAN',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links (vendor support pages etc.) open in the user's
  // default browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
  // Same for in-page navigation away from the local file.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const ja = (app.getLocale() || '').toLowerCase().startsWith('ja');
  const L = (j, e) => (ja ? j : e);
  const template = [];
  if (isMac) {
    template.push({
      label: 'BIOSMAN',
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
    });
  }
  template.push({
    label: L('ファイル', 'File'),
    submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
  });
  template.push({
    label: L('編集', 'Edit'),
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  });
  template.push({
    label: L('表示', 'View'),
    submenu: [
      { role: 'reload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerBridge();
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
