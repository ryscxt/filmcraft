// End-to-end check of the Barley host in headless Chrome over the DevTools protocol, with a
// virtual passkey authenticator. No npm packages (Node >= 24).
//
//   SETUP_TOKEN=e2e DATA_DIR=$(mktemp -d) DIST_DIR=../../../target/web/dist node src/main.ts &
//   node test/e2e.mjs --url http://localhost:3000 --token e2e --out /tmp/fc-e2e
//
// Steps: first admin with a passkey → new project → FilmCraft makes bars and tone and exports
// H.264 (lands on the server in exports/) → Save As (lands as the project) → the exported MP4 is
// mounted from the server and imported (Range reads) → save → reload reopens the project with its
// media → a save over someone else's newer version is kept as a copy. Exits non-zero on failure.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("url", "http://localhost:3000");
const setupToken = arg("token", "e2e");
const out = arg("out", join(tmpdir(), "fc-barley-e2e"));
const chrome = arg("chrome", process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const port = Number(arg("port", "9334"));
mkdirSync(out, { recursive: true });

const proc = spawn(chrome, [
  ...(process.argv.includes("--headed") ? [] : ["--headless=new"]),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "fc-chrome-"))}`,
  "--no-first-run", "--no-default-browser-check", "--enable-unsafe-webgpu",
  "--autoplay-policy=no-user-gesture-required", "--window-size=1500,950", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let nextId = 1;
const waiting = new Map();
const logs = [];
const dialogs = [];

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && waiting.has(msg.id)) {
            waiting.get(msg.id)(msg);
            waiting.delete(msg.id);
          } else if (msg.method === "Runtime.consoleAPICalled") {
            logs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
          } else if (msg.method === "Runtime.exceptionThrown") {
            logs.push("EXCEPTION " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
          } else if (msg.method === "Page.javascriptDialogOpening") {
            // confirm()/prompt() in the host page: accept, as a person choosing OK would
            dialogs.push(msg.params.message);
            send("Page.handleJavaScriptDialog", { accept: true });
          }
        };
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome did not start");
}
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))));
}
async function js(expr, timeout = 120000) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function until(expr, ms = 60000, step = 200) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await js(expr).catch(() => false)) return;
    await sleep(step);
  }
  throw new Error(`timed out: ${expr}`);
}
async function go(path) {
  await send("Page.navigate", { url: base + path });
  await sleep(300);
  await until("document.readyState === 'complete'");
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const f = join(out, `${name}.png`);
  writeFileSync(f, Buffer.from(data, "base64"));
  return f;
}
const list = (dir, recursive = false) => js(`fetch('/api/files?dir=${encodeURIComponent(dir)}${recursive ? "&recursive=1" : ""}').then(r => r.json()).then(d => d.entries.map(e => e.path))`);
const editorReady = () => until("!!(window.filmcraftLoad && window.filmcraftLoad.readyMs)", 180000);
const exec = (cmd, params = {}) => js(`filmcraft.execute(${JSON.stringify(cmd)}, ${JSON.stringify(params)})`);
async function waitJob(job) {
  await until(`filmcraft.execute("jobs.list").then(js => js.some(j => j.id === ${job} && j.finished))`, 300000, 300);
}

const report = { steps: {} };
let failed = null;
try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("WebAuthn.enable");
  await send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  // 1. first admin
  await go(`/setup#${setupToken}`);
  await until("!document.getElementById('setup').classList.contains('hidden')");
  await js(`document.getElementById('setup-name').value = 'E2E'; document.getElementById('setup-form').requestSubmit(); true`);
  await until("location.pathname === '/' && !!document.getElementById('me').textContent", 30000);
  report.steps.setup = { me: await js("document.getElementById('me').textContent") };

  // 2. new project
  await js(`fetch('/api/files/mkdir', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: 'Test'})}).then(r => r.status)`);
  await go("/edit?new=Test/Test.fcproj");
  await editorReady();
  report.steps.editor = { load: await js("window.filmcraftLoad"), info: await js("filmcraft.info()") };

  // 3. bars and tone → H.264 export, which the host stores on the server
  const bars = await exec("file.newBarsAndTone", { seconds: 2 });
  await exec("file.newSequence", { fromItem: bars.item, name: "Bars" });
  const ex = await exec("file.exportMedia", { format: "h264", path: "/exports/bars.mp4", bitrateKbps: 3000 });
  await waitJob(ex.job);
  await until(`fetch('/api/files?dir=Test/exports').then(r => r.json()).then(d => d.entries.some(e => e.name === 'bars.mp4' && e.size > 1000))`, 60000);
  report.steps.export = await list("Test", true);

  // 4. first save of the new project = Save As → Test/Test.fcproj on the server
  await exec("file.saveAs", { path: "/projects/Test.fcproj" });
  await until(`fetch('/api/files?dir=Test').then(r => r.json()).then(d => d.entries.some(e => e.name === 'Test.fcproj'))`, 30000);
  await until("location.search.includes('project=')", 10000);
  report.steps.saveAs = { url: await js("location.pathname + location.search") };

  // 5. the export, mounted from the server and imported with Range reads
  const size = await js(`fetch('/api/files?dir=Test/exports').then(r => r.json()).then(d => d.entries.find(e => e.name === 'bars.mp4').size)`);
  await js(`filmcraft.mountUrl('/api/files/raw/Test/exports/bars.mp4', '/files/Test/exports/bars.mp4', ${size})`);
  const imp = await js(`filmcraft.importMounted(['/files/Test/exports/bars.mp4'])`);
  if (!imp.items?.length) throw new Error("import from the server failed: " + JSON.stringify(imp));
  await exec("file.newSequence", { fromItem: imp.items[0], name: "From server" });
  await js("filmcraft.request('ui.playback', {action: 'play'})");
  await sleep(1500);
  await js("filmcraft.request('ui.playback', {action: 'stop'})");
  report.steps.importMounted = { imp, screenshot: await shot("01-imported-from-server"), resources: await js("performance.getEntriesByType('resource').filter(e => e.name.includes('/api/files/raw/')).length") };
  await exec("file.save", {});
  await until(`!document.getElementById('dot').classList.contains('dirty')`, 15000);
  await sleep(1000);

  // 6. reload: the project comes back from the server, its media mounted again
  await go("/edit?project=Test/Test.fcproj");
  await editorReady();
  await sleep(2500);
  const inspect = await js("filmcraft.inspect()");
  report.steps.reopen = { sequences: inspect.sequences ?? inspect.activeSequence, screenshot: await shot("02-reopened") };
  const offline = logs.filter((l) => /not found|offline|missing/i.test(l));
  if (offline.length) throw new Error("media not found after reopening: " + offline.join(" | "));

  // 7. someone else saves the project meanwhile: our save must not overwrite it
  await js(`fetch('/api/files/raw/Test/Test.fcproj', {method: 'PUT', body: 'someone else'}).then(r => r.status)`);
  await exec("file.newBarsAndTone", { seconds: 1 }); // a change
  await exec("file.save", {});
  await until(`fetch('/api/files?dir=Test').then(r => r.json()).then(d => d.entries.some(e => e.name.includes('(kopia')))`, 15000);
  const kept = await js(`fetch('/api/files/raw/Test/Test.fcproj').then(r => r.text())`);
  if (kept !== "someone else") throw new Error("the other person's save was overwritten");
  report.steps.conflict = { dialogs: [...dialogs], files: await list("Test") };
} catch (e) {
  failed = e;
  report.error = String(e.stack || e);
  await shot("failure").catch(() => {});
}
const panics = logs.filter((l) => /panicked at|EXCEPTION/.test(l));
if (panics.length && !failed) failed = new Error("console errors: " + panics.join(" | "));
report.logs = logs.slice(-60);
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: !failed, error: failed ? String(failed) : undefined, steps: Object.keys(report.steps), out }, null, 2));
ws?.close();
proc.kill();
process.exit(failed ? 1 : 0);
