import { api } from "/assets/api.js";

const { startAuthentication, startRegistration, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;
const $ = (id) => document.getElementById(id);
const msg = (text, err = false) => { $("msg").textContent = text; $("msg").className = `msg ${err ? "err" : "muted"}`; };
const show = (id) => $(id).classList.remove("hidden");
const secret = location.hash.slice(1);

function niceError(e) {
  if (e?.name === "NotAllowedError") return "Anulowano lub upłynął czas. Spróbuj ponownie.";
  if (e?.name === "InvalidStateError") return "Ten passkey jest już zarejestrowany.";
  return e?.message || String(e);
}

async function register(mode, extra) {
  const { flow, options } = await api("/api/auth/register/options", { method: "POST", body: { mode, ...extra, label: deviceLabel() } });
  const response = await startRegistration({ optionsJSON: options });
  await api("/api/auth/register/verify", { method: "POST", body: { flow, response } });
  location.replace("/");
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Mac/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "Urządzenie";
  return `${os} · ${new Date().toLocaleDateString("pl-PL")}`;
}

async function login() {
  msg("Czekam na passkey…");
  try {
    const { flow, options } = await api("/api/auth/login/options", { method: "POST" });
    const response = await startAuthentication({ optionsJSON: options });
    await api("/api/auth/login/verify", { method: "POST", body: { flow, response } });
    location.replace("/");
  } catch (e) {
    msg(niceError(e), true);
  }
}

async function main() {
  if (!browserSupportsWebAuthn()) return msg("Ta przeglądarka nie obsługuje passkeys.", true);
  const status = await api("/api/auth/status");
  const path = location.pathname;
  if (status.signedIn && path !== "/invite") return location.replace("/");
  if (path === "/setup" || status.needsSetup) {
    if (!status.needsSetup) return location.replace("/login");
    if (path !== "/setup") return location.replace("/setup");
    show("setup");
    if (secret) $("setup-token").value = decodeURIComponent(secret);
    $("setup-form").onsubmit = async (ev) => {
      ev.preventDefault();
      msg("Tworzę passkey…");
      try { await register("setup", { token: $("setup-token").value, name: $("setup-name").value }); } catch (e) { msg(niceError(e), true); }
    };
    return;
  }
  if (path === "/invite") {
    try {
      const inv = await api(`/api/auth/invite?token=${encodeURIComponent(secret)}`);
      if (inv.note) $("invite-lead").textContent = `${inv.note} — podaj imię i zarejestruj passkey.`;
    } catch (e) {
      return msg(niceError(e), true);
    }
    show("invite");
    $("invite-form").onsubmit = async (ev) => {
      ev.preventDefault();
      msg("Tworzę passkey…");
      try { await register("invite", { token: secret, name: $("invite-name").value }); } catch (e) { msg(niceError(e), true); }
    };
    return;
  }
  show("login");
  $("login-btn").onclick = login;
}

main().catch((e) => msg(niceError(e), true));
