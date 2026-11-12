import { api, rawUrl, fmtSize, fmtDate, toast, upload } from "/assets/api.js";

const $ = (id) => document.getElementById(id);
const MEDIA = /\.(mp4|m4v|mov|mkv|webm|mxf|avi|wav|mp3|m4a|aac|flac|ogg|opus|png|jpe?g|gif|webp|tiff?|srt|vtt)$/i;
let dir = decodeURIComponent(location.hash.slice(1));
let me = null;

const icon = (e) => (e.dir ? "📁" : /\.fcproj$/i.test(e.name) ? "🎬" : MEDIA.test(e.name) ? "🎞️" : "📄");
const join = (a, b) => (a ? `${a}/${b}` : b);
const validName = (n) => n && !/[\\/\0]/.test(n) && n !== "." && n !== ".." && !n.startsWith(".fc-upload-");

function go(d) {
  dir = d;
  history.replaceState(null, "", d ? `#${encodeURIComponent(d)}` : location.pathname);
  load();
}

function crumbs() {
  const nav = $("crumbs");
  nav.replaceChildren();
  const parts = dir ? dir.split("/") : [];
  const mk = (label, target) => {
    const b = document.createElement("button");
    b.className = "ghost";
    b.type = "button";
    b.textContent = label;
    b.onclick = () => go(target);
    return b;
  };
  nav.append(mk("Pliki", ""));
  parts.forEach((p, i) => {
    nav.append(Object.assign(document.createElement("span"), { textContent: "/", className: "muted" }));
    nav.append(mk(p, parts.slice(0, i + 1).join("/")));
  });
}

function openEditor(path) {
  location.href = `/edit?project=${encodeURIComponent(path)}`;
}

async function load() {
  crumbs();
  let entries;
  try {
    ({ entries } = await api(`/api/files?dir=${encodeURIComponent(dir)}`));
  } catch (e) {
    if (e.status === 404 && dir) return go("");
    return toast(e.message, "err");
  }
  const rows = $("rows");
  rows.replaceChildren();
  $("empty").classList.toggle("hidden", entries.length > 0);
  for (const e of entries) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "name";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = `${icon(e)} ${e.name}`;
    open.onclick = () => (e.dir ? go(e.path) : /\.fcproj$/i.test(e.name) ? openEditor(e.path) : window.open(rawUrl(e.path), "_blank", "noopener"));
    name.append(open);
    if (e.lockedBy) name.append(Object.assign(document.createElement("span"), { className: "badge", textContent: `edytuje: ${e.lockedBy}` }));
    const size = Object.assign(document.createElement("td"), { className: "col-size muted", textContent: e.dir ? "—" : fmtSize(e.size) });
    const date = Object.assign(document.createElement("td"), { className: "col-date muted", textContent: fmtDate(e.mtime) });
    const actions = document.createElement("td");
    actions.className = "actions";
    const btn = (label, fn, cls = "ghost") => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, className: cls });
      b.onclick = fn;
      actions.append(b);
    };
    if (!e.dir) btn("Pobierz", () => (location.href = `${rawUrl(e.path)}?download=1`));
    btn("Zmień nazwę", () => rename(e));
    btn("Usuń", () => remove(e), "ghost danger");
    tr.append(name, size, date, actions);
    rows.append(tr);
  }
}

async function rename(e) {
  const n = prompt("Nowa nazwa:", e.name);
  if (!n || n === e.name) return;
  if (!validName(n)) return toast("Niedozwolona nazwa.", "err");
  try {
    await api("/api/files/move", { method: "POST", body: { from: e.path, to: join(dir, n) } });
    load();
  } catch (err) { toast(err.message, "err"); }
}

async function remove(e) {
  if (!confirm(`Przenieść „${e.name}” do kosza na serwerze?`)) return;
  try {
    await api(rawUrl(e.path), { method: "DELETE" });
    load();
  } catch (err) { toast(err.message, "err"); }
}

async function uploadAll(list) {
  for (const f of list) {
    try {
      await upload(f, join(dir, f.name));
    } catch (e) { toast(`${f.name}: ${e.message}`, "err"); }
  }
  load();
}

// drag & drop anywhere
let depth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { depth++; $("drop").classList.remove("hidden"); } });
addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("drop").classList.add("hidden"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  depth = 0;
  $("drop").classList.add("hidden");
  if (e.dataTransfer?.files.length) uploadAll([...e.dataTransfer.files]);
});

$("upload-btn").onclick = () => $("upload-input").click();
$("upload-input").onchange = (e) => { uploadAll([...e.target.files]); e.target.value = ""; };
$("new-folder").onclick = async () => {
  const n = prompt("Nazwa folderu:");
  if (!n) return;
  if (!validName(n)) return toast("Niedozwolona nazwa.", "err");
  try { await api("/api/files/mkdir", { method: "POST", body: { path: join(dir, n) } }); load(); } catch (e) { toast(e.message, "err"); }
};
$("new-project").onclick = async () => {
  const n = prompt("Nazwa projektu:", "Nowy projekt");
  if (!n) return;
  if (!validName(n)) return toast("Niedozwolona nazwa.", "err");
  // a project gets its own folder: media and exports go next to it
  const folder = join(dir, n);
  try {
    await api("/api/files/mkdir", { method: "POST", body: { path: folder } });
    location.href = `/edit?new=${encodeURIComponent(join(folder, `${n}.fcproj`))}`;
  } catch (e) { toast(e.message, "err"); }
};
$("logout-btn").onclick = async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); location.replace("/login"); };

// account & admin
async function account() {
  const data = await api("/api/me");
  const list = $("passkeys");
  list.replaceChildren();
  for (const p of data.passkeys) {
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.append(Object.assign(document.createElement("span"), { textContent: `${p.label} · ostatnio ${fmtDate(p.last_used_at)}` }));
    const del = Object.assign(document.createElement("button"), { type: "button", className: "ghost danger", textContent: "Usuń" });
    del.disabled = data.passkeys.length <= 1;
    del.onclick = async () => { if (confirm("Usunąć ten passkey?")) { try { await api(`/api/me/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); account(); } catch (e) { toast(e.message, "err"); } } };
    row.append(del);
    list.append(row);
  }
  $("admin").classList.toggle("hidden", !data.admin);
  if (!data.admin) return;
  const { users } = await api("/api/users");
  $("users").replaceChildren(...users.map((u) => {
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.append(Object.assign(document.createElement("span"), { textContent: `${u.name}${u.admin ? " (admin)" : ""} · ${u.passkeys} passkey · ostatnio ${fmtDate(u.last_used_at)}` }));
    if (u.id !== data.id) {
      const del = Object.assign(document.createElement("button"), { type: "button", className: "ghost danger", textContent: "Odbierz dostęp" });
      del.onclick = async () => { if (confirm(`Odebrać dostęp osobie ${u.name}? Jej passkeys i sesje zostaną usunięte.`)) { await api(`/api/users/${encodeURIComponent(u.id)}`, { method: "DELETE" }).catch((e) => toast(e.message, "err")); account(); } };
      row.append(del);
    }
    return row;
  }));
  const { invites } = await api("/api/invites");
  const live = invites.filter((i) => !i.used_at && i.expires_at > Date.now());
  $("invites").replaceChildren(...(live.length ? live.map((i) => {
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.append(Object.assign(document.createElement("span"), { textContent: `${i.note || "Zaproszenie"} · wygasa ${fmtDate(i.expires_at)}` }));
    const del = Object.assign(document.createElement("button"), { type: "button", className: "ghost danger", textContent: "Unieważnij" });
    del.onclick = async () => { await api(`/api/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" }); account(); };
    row.append(del);
    return row;
  }) : [Object.assign(document.createElement("div"), { className: "muted", textContent: "Brak aktywnych zaproszeń." })]));
}

$("account-btn").onclick = async () => { $("invite-out").classList.add("hidden"); $("account").showModal(); account().catch((e) => toast(e.message, "err")); };
$("account-close").onclick = () => $("account").close();
$("add-passkey").onclick = async () => {
  try {
    const { startRegistration } = window.SimpleWebAuthnBrowser;
    const { flow, options } = await api("/api/auth/register/options", { method: "POST", body: { mode: "add", label: `${navigator.platform || "Urządzenie"} · ${new Date().toLocaleDateString("pl-PL")}` } });
    const response = await startRegistration({ optionsJSON: options });
    await api("/api/auth/register/verify", { method: "POST", body: { flow, response } });
    toast("Dodano passkey.", "ok");
    account();
  } catch (e) { toast(e.name === "NotAllowedError" ? "Anulowano." : e.message, "err"); }
};
$("new-invite").onclick = async () => {
  const note = prompt("Dla kogo? (opcjonalnie)", "") ?? "";
  try {
    const inv = await api("/api/invites", { method: "POST", body: { note } });
    $("invite-url").textContent = inv.url;
    $("invite-out").classList.remove("hidden");
    navigator.clipboard?.writeText(inv.url).then(() => toast("Skopiowano link.", "ok"), () => {});
    account();
  } catch (e) { toast(e.message, "err"); }
};

api("/api/me").then((d) => { me = d; $("me").textContent = d.name; }).catch(() => location.replace("/login"));
load();
