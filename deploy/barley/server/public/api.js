// fetch helpers shared by the pages
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** URL of a file in the shared folder (each segment encoded). */
export const rawUrl = (rel) => "/api/files/raw/" + rel.split("/").map(encodeURIComponent).join("/");

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—");

export function toast(text, kind = "") {
  let box = document.querySelector(".uploads");
  if (!box) {
    box = document.createElement("div");
    box.className = "uploads";
    document.body.append(box);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.append(t);
  setTimeout(() => t.remove(), kind === "err" ? 9000 : 4000);
}

/** Upload with progress (XHR: fetch has no upload progress). Resolves with the server's reply. */
export function upload(file, rel, headers = {}) {
  return new Promise((resolve, reject) => {
    const box = document.querySelector(".uploads") || document.body.appendChild(Object.assign(document.createElement("div"), { className: "uploads" }));
    const item = Object.assign(document.createElement("div"), { className: "upload" });
    const label = Object.assign(document.createElement("div"), { textContent: file.name });
    const bar = Object.assign(document.createElement("progress"), { max: 1, value: 0 });
    item.append(label, bar);
    box.append(item);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", rawUrl(rel));
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && (bar.value = ev.loaded / ev.total);
    xhr.onload = () => {
      item.remove();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => { item.remove(); reject(new Error(`${file.name}: błąd sieci`)); };
    xhr.send(file);
  });
}

