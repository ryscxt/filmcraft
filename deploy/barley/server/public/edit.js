// The editor page: FilmCraft in page host mode (data-host="page") with the shared server folder
// as its storage. Server files are mounted into FilmCraft's virtual /files/ folder by URL (read
// on demand with Range requests), the project opens over `filmcraft:open`, and everything the
// app saves arrives as `filmcraft:save` and is written back to the server.
import { api, rawUrl, toast, upload } from "/assets/api.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isNew = params.has("new");
let docRel = params.get("project") || params.get("new") || "";
let docEtag = null; // the version we opened or last saved: a save fails with 412 if someone else saved since
let dirty = false;
let haveLock = false;
let onServer = !isNew; // a new project exists on the server only after its first save
const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
const join = (a, b) => (a ? `${a}/${b}` : b);
const PROJECT = /\.fcproj$/i;
const canvas = $("filmcraft_canvas");

if (!docRel || !PROJECT.test(docRel)) location.replace("/");

function setDoc(rel) {
  docRel = rel;
  $("doc").textContent = rel;
  document.title = `${dirty ? "● " : ""}${baseOf(rel)} · FilmCraft`;
  if (!onServer) return;
  const q = new URLSearchParams(params);
  q.delete("new");
  q.set("project", rel);
  history.replaceState(null, "", `/edit?${q.toString().replace(/=(&|$)/g, "$1")}`);
}
function setDirty(d) {
  dirty = d;
  $("dot").classList.toggle("dirty", d);
  $("dot").title = d ? "Niezapisane zmiany" : "Zapisano na serwerze";
  document.title = `${d ? "● " : ""}${baseOf(docRel)} · FilmCraft`;
}
$("doc").textContent = docRel;
$("back").onclick = () => (location.href = `/#${encodeURIComponent(dirOf(docRel))}`);
addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// --- soft lock: tell others this project is open here ---
async function lock() {
  try {
    const r = await api("/api/locks", { method: "POST", body: { path: docRel } });
    haveLock = r.ok;
    $("lock").classList.toggle("hidden", r.ok);
    if (!r.ok) $("lock").textContent = `otwarty też przez: ${r.holder}`;
    return r;
  } catch {
    return { ok: true };
  }
}
setInterval(lock, 30_000);
addEventListener("pagehide", () => {
  if (haveLock) fetch("/api/locks", { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: docRel }) });
});

// --- server files → FilmCraft's /files/ ---
const MOUNTABLE = /\.(mp4|m4v|mov|mkv|webm|mxf|avi|wav|mp3|m4a|aac|flac|ogg|opus|png|jpe?g|gif|webp|tiff?|bmp|dng|exr|srt|vtt|ass|ttml|scc|xml|edl|aaf|omf|cube)$/i;
async function mountAll() {
  const { entries } = await api("/api/files?dir=&recursive=1");
  let n = 0;
  for (const e of entries) {
    if (e.dir || !MOUNTABLE.test(e.name)) continue;
    try {
      window.filmcraft.mountUrl(rawUrl(e.path), `/files/${e.path}`, e.size);
      n++;
    } catch (err) {
      console.warn("mount", e.path, err);
    }
  }
  return n;
}

// --- saves from the app → server ---
async function put(rel, bytes, headers = {}) {
  const res = await fetch(rawUrl(rel), { method: "PUT", body: bytes, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");

async function onSave({ name, saveAs, bytes }) {
  const isProject = PROJECT.test(name);
  try {
    if (isProject && (saveAs || name === baseOf(docRel))) {
      // the document: saveAs adopts a new name next to the current one
      const target = saveAs ? join(dirOf(docRel), name) : docRel;
      const headers = {};
      if (target === docRel && docEtag) headers["If-Match"] = docEtag;
      else if (target !== docRel || !docEtag) headers["If-None-Match"] = "*";
      let r;
      try {
        r = await put(target, bytes, headers);
      } catch (e) {
        if (e.status !== 412) throw e;
        const copy = join(dirOf(target), `${baseOf(target).replace(PROJECT, "")} (kopia ${stamp()}).fcproj`);
        const msg =
          target === docRel && docEtag
            ? `Ktoś inny zapisał „${baseOf(target)}” po tym, jak go otworzyłeś.\n\nOK – zapisz Twoją wersję jako kopię „${baseOf(copy)}”\nAnuluj – nie zapisuj (Twoje zmiany zostają w edytorze)`
            : `Plik „${baseOf(target)}” już istnieje na serwerze.\n\nOK – zapisz jako „${baseOf(copy)}”\nAnuluj – nie zapisuj`;
        if (!confirm(msg)) return toast("Nie zapisano.", "err");
        r = await put(copy, bytes, { "If-None-Match": "*" });
      }
      onServer = true;
      if (r.path !== docRel || location.search.includes("new=")) {
        if (haveLock) api("/api/locks", { method: "DELETE", body: { path: docRel } }).catch(() => {});
        setDoc(r.path);
        lock();
      }
      docEtag = r.etag;
      toast(`Zapisano ${r.path}`, "ok");
    } else {
      // copies, exports, captions, interchange: next to the project, exports in exports/
      const target = isProject ? join(dirOf(docRel), name) : join(join(dirOf(docRel), "exports"), name);
      const r = await put(target, bytes);
      toast(`Zapisano ${r.path}`, "ok");
    }
  } catch (e) {
    toast(`Nie udało się zapisać ${name}: ${e.message}`, "err");
  }
}

// --- media from the user's disk: upload first, then import from the server ---
$("add-media").onclick = () => $("media-input").click();
$("media-input").onchange = async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  const paths = [];
  for (const f of files) {
    try {
      const r = await upload(f, join(dirOf(docRel), f.name), { "If-None-Match": "*" }).catch(async (e) => {
        if (e.status !== 412) throw e;
        const dot = f.name.lastIndexOf(".");
        const alt = dot > 0 ? `${f.name.slice(0, dot)} (${stamp()})${f.name.slice(dot)}` : `${f.name} (${stamp()})`;
        return upload(f, join(dirOf(docRel), alt), { "If-None-Match": "*" });
      });
      window.filmcraft.mountUrl(rawUrl(r.path), `/files/${r.path}`, r.size);
      paths.push(`/files/${r.path}`);
    } catch (e) {
      toast(`${f.name}: ${e.message}`, "err");
    }
  }
  if (paths.length) {
    const r = await window.filmcraft.importMounted(paths);
    if (r.errors?.length) toast(r.errors.join("; "), "err");
    else toast(`Zaimportowano ${paths.length} plik(ów).`, "ok");
  }
};
$("refresh").onclick = async () => {
  try {
    toast(`Podłączono ${await mountAll()} plików z serwera.`, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};
// Files dropped on the page would stay on this computer only: upload them instead. FilmCraft
// listens for drops on the window in the capture phase; this listener is registered before the
// app starts, so it runs first and keeps the drop from reaching it.
addEventListener("drop", (ev) => {
  if (!ev.dataTransfer?.files?.length) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const input = $("media-input");
  const dt = new DataTransfer();
  for (const f of ev.dataTransfer.files) if (!PROJECT.test(f.name)) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change"));
}, true);

// --- host events: listeners first, then start the app ---
async function onReady() {
  try {
    await mountAll();
    if (isNew) {
      setDoc(docRel);
      toast("Nowy projekt. Pierwszy zapis (⌘S / Ctrl+S) utworzy plik na serwerze.");
      return;
    }
    const res = await fetch(rawUrl(docRel), { credentials: "same-origin" });
    if (!res.ok) throw new Error(res.status === 404 ? "projekt nie istnieje" : `HTTP ${res.status}`);
    docEtag = res.headers.get("ETag");
    const bytes = await res.arrayBuffer();
    canvas.dispatchEvent(new CustomEvent("filmcraft:open", { detail: { name: baseOf(docRel), bytes } }));
    setDoc(docRel);
  } catch (e) {
    toast(`Nie udało się otworzyć projektu: ${e.message}`, "err");
  }
}
canvas.addEventListener("filmcraft:ready", () => { onReady(); });
canvas.addEventListener("filmcraft:save", (ev) => { onSave(ev.detail); });
canvas.addEventListener("filmcraft:dirty", (ev) => setDirty(!!ev.detail?.dirty));
function showStartError(text) {
  const s = $("status");
  if (s) {
    s.className = "err";
    s.textContent = `FilmCraft nie mógł wystartować:\n${text}`;
  } else {
    toast(`FilmCraft nie mógł wystartować: ${text}`, "err");
  }
}
canvas.addEventListener("filmcraft:failed", (ev) => showStartError(ev.detail?.error ?? ""));

async function buildHash() {
  // `cargo xtask web` stamps a hash of the build into its index.html; the glue and wasm are
  // requested with it so they can be cached as immutable
  const html = await fetch("/fc/index.html", { cache: "no-cache" }).then((r) => r.text()).catch(() => "");
  const m = /const build = "([0-9a-f]+)"/.exec(html);
  return m ? `?v=${m[1]}` : "";
}

async function start() {
  const r = await lock();
  if (!r.ok && !confirm(`${r.holder} ma teraz otwarty ten projekt.\n\nJeśli oboje zapiszecie, drugi zapis zostanie zatrzymany i zapisze się jako kopia.\nOtworzyć mimo to?`)) {
    location.href = `/#${encodeURIComponent(dirOf(docRel))}`;
    return;
  }
  const t0 = performance.now();
  const v = await buildHash();
  try {
    const { default: init, start: run } = await import(`/fc/filmcraft_web.js${v}`);
    await init({ module_or_path: new URL(`/fc/filmcraft_web_bg.wasm${v}`, location.href) });
    window.filmcraftLoad.wasmMs = performance.now() - t0;
    await run("filmcraft_canvas");
    window.filmcraftLoad.readyMs = performance.now() - t0;
    $("loading")?.remove(); // FilmCraft removes it itself once it runs
    canvas.focus();
  } catch (e) {
    const text = String((e && e.stack) || e);
    // WebGPU found but failed to start: retry once on WebGL2
    if (!params.has("webgl") && !params.has("cpu") && /wgpu|webgpu|requestDevice|requestAdapter|GPUDevice|surface/i.test(text)) {
      params.set("webgl", "");
      location.replace(`/edit?${params.toString().replace(/=(&|$)/g, "$1")}`);
      return;
    }
    showStartError(text);
  }
}
start();
