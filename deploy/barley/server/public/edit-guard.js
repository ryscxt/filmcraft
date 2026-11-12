// Loaded before the app: turn a Rust panic or out-of-memory trap into a visible message instead of
// a frozen canvas (the same guard as FilmCraft's own index.html).
window.filmcraftLoad = {};
(() => {
  let lastPanic = null;
  const consoleError = console.error.bind(console);
  console.error = (...a) => {
    const m = a.map(String).join(" ");
    if (/panicked at|memory allocation of/.test(m)) lastPanic = m;
    consoleError(...a);
  };
  window.filmcraftFatal = (what) => {
    if (window.filmcraftLoad.fatal) return;
    const msg = lastPanic || String((what && (what.stack || what.message)) || what);
    window.filmcraftLoad.fatal = msg;
    document.getElementById("fatal-msg").textContent = msg.split("\n\nStack:")[0];
    document.getElementById("fatal").classList.add("on");
  };
  const isFatal = (e) => e instanceof WebAssembly.RuntimeError || /panicked at|unreachable|memory access out of bounds/.test(String((e && e.message) || e));
  addEventListener("error", (ev) => { if (window.filmcraftLoad.readyMs && isFatal(ev.error || ev.message)) window.filmcraftFatal(ev.error || ev.message); });
  addEventListener("unhandledrejection", (ev) => { if (window.filmcraftLoad.readyMs && isFatal(ev.reason)) window.filmcraftFatal(ev.reason); });
  addEventListener("DOMContentLoaded", () => { document.getElementById("fatal-reload").onclick = () => location.reload(); });
})();
