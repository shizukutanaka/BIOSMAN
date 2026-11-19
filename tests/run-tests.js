// BIOSMAN logic tests — node tests/run-tests.js [path-to-index.html]
// Zero dependencies. Exercises version logic and the collector flow
// in vm sandboxes, with stubs for the DOM and Electron.
//
// Sections tagged [baseline] cover behaviour that predates the ASUS
// auto-fetch feature; they must pass against any version of the file.
// Sections tagged [asus] cover the new feature; when run against an
// older index.html the functions are absent and the tests report
// SKIP-ABSENT instead of failing, so a before/after comparison shows
// exactly what the feature added.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const scripts = scriptBlocks.join('\n');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  const begin = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const sandbox = { console };
vm.createContext(sandbox);
// Top-level constants the extracted functions close over.
for (const m of scripts.matchAll(/var (ASUS_API_BASE) = "[^"]*";/g)) {
  vm.runInContext(m[0], sandbox);
}
const FN_NAMES = ['normVer', 'tokenizeVer', 'cmpVer', 'extractVersionCandidates', 'asusApiUrl', 'parseAsusBiosResponse'];
const present = {};
for (const name of FN_NAMES) {
  const src = extractFn(scripts, name);
  present[name] = !!src;
  if (src) vm.runInContext(src, sandbox);
}
const L = sandbox;

let pass = 0, fail = 0, skip = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }
function section(tag, needs, fn) {
  const missing = needs.filter(n => !present[n]);
  if (missing.length) {
    skip++;
    console.log(`SKIP-ABSENT [${tag}] needs ${missing.join(', ')}`);
    return;
  }
  fn();
}

/* ---------------- [baseline] version comparison ---------------- */
section('baseline', ['cmpVer', 'normVer'], () => {
  const s = (a, b) => Math.sign(L.cmpVer(a, b));
  ok(s('1.9', '1.10') === -1, 'cmpVer: 1.9 < 1.10 (numeric tokens, not string order)');
  ok(s('3886', '4004') === -1, 'cmpVer: 3886 < 4004');
  ok(s('5055', '4004') === 1, 'cmpVer: 5055 > 4004');
  ok(s('4004', '4004') === 0, 'cmpVer: equal');
  ok(s('F12', 'F13') === -1, 'cmpVer: F12 < F13 (letter+number tokens)');
  ok(s('v4004', '4004') === 0, 'cmpVer: leading v is normalised away');
  ok(s('2.0', '10.0') === -1, 'cmpVer: 2.0 < 10.0');
  ok(s('1.0a', '1.0b') === -1, 'cmpVer: 1.0a < 1.0b');
  ok(s('', '1') === -1, 'cmpVer: empty < 1');
  ok(L.normVer(' V1.2 ') === '1.2', 'normVer trims and strips leading v');
});

/* ---------------- [baseline] heuristic page extraction ---------------- */
section('baseline', ['extractVersionCandidates'], () => {
  const sample = '<html><body><div>BIOS</div><div>Version 4004</div>' +
    '<a href="x">ROG-STRIX-B650E-F-GAMING-WIFI-ASUS-3881.CAP</a></body></html>';
  const cands = L.extractVersionCandidates(sample);
  ok(cands.includes('4004'), 'extractVersionCandidates finds labelled version');
  ok(cands.includes('3881'), 'extractVersionCandidates finds .CAP file version');
});

/* ---------------- [asus] API URL builder ---------------- */
section('asus', ['asusApiUrl'], () => {
  const u = L.asusApiUrl('ROG STRIX B650E-F GAMING WIFI');
  ok(u.startsWith('https://www.asus.com/support/api/product.asmx/GetPDBIOS?'), 'asusApiUrl: official asus.com endpoint');
  ok(u.includes('website=global'), 'asusApiUrl: website=global');
  ok(u.includes('model=ROG%20STRIX%20B650E-F%20GAMING%20WIFI'), 'asusApiUrl: model is URL-encoded');
  ok(u.includes('sitelang=en'), 'asusApiUrl: sitelang=en');
});

/* ---------------- [asus] response parser ---------------- */
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'asus-b650ef.json'), 'utf8'));
const fixtureText = JSON.stringify(fixture);
const failText = fs.readFileSync(path.join(__dirname, 'fixtures', 'asus-fail.json'), 'utf8');

section('asus', ['parseAsusBiosResponse'], () => {
  const r = L.parseAsusBiosResponse(fixtureText);
  ok(r.ok === true, 'parse: real capture parses');
  ok(r.version === '4004', 'parse: latest version from real capture is 4004 (got ' + (r && r.version) + ')');
  ok(r.releaseDate === '2026/09/21', 'parse: release date of latest is 2026/09/21');

  const f = L.parseAsusBiosResponse(failText);
  ok(f.ok === false, 'parse: FAIL response (unknown model) is not ok');

  ok(L.parseAsusBiosResponse('not json at all').ok === false, 'parse: garbage is not ok');
  ok(L.parseAsusBiosResponse('').ok === false, 'parse: empty is not ok');
  ok(L.parseAsusBiosResponse('{"Status":"SUCCESS","Result":{"Obj":[]}}').ok === false,
    'parse: SUCCESS but no BIOS list is not ok');

  // Order independence: the parser must pick the maximum by version
  // order, not trust the row order of the response.
  const shuffled = JSON.parse(fixtureText);
  shuffled.Result.Obj[0].Files.reverse();
  const rs = L.parseAsusBiosResponse(JSON.stringify(shuffled));
  ok(rs.ok && rs.version === '4004', 'parse: reversed file order still yields 4004');

  // The "Firmware" object (Version "-") must never win.
  const fwOnly = JSON.stringify({ Status: 'SUCCESS', Result: { Obj: [fixture.Result.Obj[1]] } });
  ok(L.parseAsusBiosResponse(fwOnly).ok === false, 'parse: Firmware-only response is not ok');

  // Same version twice: the later release date wins.
  const tie = JSON.stringify({ Status: 'SUCCESS', Result: { Obj: [{ Name: 'BIOS', Files: [
    { Version: '3001', ReleaseDate: '2025/01/10' },
    { Version: '3001', ReleaseDate: '2025/03/02' },
    { Version: '2999', ReleaseDate: '2025/06/01' },
  ] }] } });
  const rt = L.parseAsusBiosResponse(tie);
  ok(rt.ok && rt.version === '3001' && rt.releaseDate === '2025/03/02',
    'parse: version tie broken by release date; older version with newer date does not win');

  // A beta-only list still yields its newest version (it is presented
  // as a candidate; a human confirms before anything is recorded).
  const beta = JSON.stringify({ Status: 'SUCCESS', Result: { Obj: [{ Name: 'BIOS', Files: [
    { Version: '3901', ReleaseDate: '2026/08/01', IsRelease: '0' },
  ] }] } });
  const rb = L.parseAsusBiosResponse(beta);
  ok(rb.ok && rb.version === '3901', 'parse: beta-only list yields the beta version as a candidate');
});

/* ---------------- same-PC collector ---------------- */
async function testLocalCollector() {
  const sample = 'BASEBOARD_MANUFACTURER=Micro-Star International\r\nBASEBOARD_PRODUCT=Test Board\r\n' +
    'BASEBOARD_VERSION=1.1\r\nBIOS_VERSION=1.09\r\nBIOS_RELEASEDATE=2026-04-06\r\n';
  const handlers = new Map();
  const window = {};
  const electron = {
    app: { setName() {}, on() {}, whenReady: () => ({ then() {} }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    ipcRenderer: { invoke: async (name) => handlers.get(name)() }
  };
  const process = { platform: 'win32' };
  let reply;
  let command;
  const electronContext = vm.createContext({
    process,
    require: (name) => ({
      path, electron, child_process: {
        execFile(file, args, options, cb) {
          command = { file, args, options };
          reply = cb;
        }
      }
    })[name]
  });
  for (const file of ['main.js', 'preload.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8'), electronContext);
  }
  vm.runInContext('registerBridge()', electronContext);

  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const events = {};
      elements.set(id, {
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        isOpen: () => classes.has('open'),
        value: '',
        addEventListener: (name, handler) => { events[name] = handler; },
        click: (event) => events.click(event)
      });
    }
    return elements.get(id);
  }
  const forms = [];
  const alerts = [];
  vm.runInNewContext(scriptBlocks.find(s => s.includes('function parseCollected(')), {
    window, document: { getElementById: el },
    t: key => key, alert: key => alerts.push(key), openBoardForm: data => forms.push(data),
    closeBoardForm() {}, submitBoardForm() {}, closeUpdate() {}, confirmUpdate() {},
    buildChecklist() {}, applyI18n() {}, render() {}
  });
  const modal = el('importModal');
  const button = el('btnCollectLocal');
  const bridge = window.biosmanPC;
  delete window.biosmanPC;
  el('btnImportFirst').click();
  ok(button.hidden, 'local collector: browser hides the desktop action');
  window.biosmanPC = bridge;
  el('btnImportOpen').click();
  ok(!button.hidden, 'local collector: Windows bridge makes action available');
  el('importMachine').value = ' Test PC ';
  const success = button.click();
  ok(button.disabled && command.file === 'powershell.exe' && command.options.timeout === 10000 &&
    command.args[3].includes('Get-CimInstance Win32_BaseBoard') &&
    command.args[3].includes('Get-CimInstance Win32_BIOS'), 'local collector: read uses the bounded Windows command');
  reply(null, sample);
  await success;
  ok(JSON.stringify(forms[0]) === JSON.stringify({
    vendor: 'MSI', model: 'Test Board', revision: '1.1', curVer: '1.09', curDate: '2026-04-06', machine: 'Test PC'
  }), 'local collector: opens a prefilled form for review');
  ok(!button.disabled && !modal.isOpen(), 'local collector: closes import on success and restores the action');

  el('btnImportOpen').click();
  const failure = button.click();
  reply(new Error('CIM unavailable'), sample);
  await failure;
  ok(alerts[0] === 'iCollectFail' && forms.length === 1 && modal.isOpen() && !button.disabled,
    'local collector: command failure discards output and leaves paste available');

  const cancelled = button.click();
  modal.click({ target: modal, currentTarget: modal });
  el('btnImportOpen').click();
  reply(null, sample);
  await cancelled;
  ok(forms.length === 1 && alerts.length === 1 && modal.isOpen(),
    'local collector: result from a closed import does not affect a reopened import');
  el('importText').value = sample;
  el('btnImportParse').click();
  ok(forms.length === 2 && JSON.stringify(forms[1]) === JSON.stringify(forms[0]),
    'local collector: the paste route still uses the same form and fields');

  process.platform = 'darwin';
  ok(await bridge.collectLocal() === null, 'local collector: main process rejects reads on other platforms');
}

testLocalCollector().catch(error => ok(false, 'local collector: ' + error.stack)).finally(() => {
  console.log(`${pass} pass / ${fail} fail / ${skip} skipped-absent`);
  process.exitCode = fail ? 1 : 0;
});
