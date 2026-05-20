const DEFAULTS = {
  enabled: true,
  domains: "localhost\n127.0.0.1\n*.local\n0.0.0.0",
  opts: {
    cache: true,
    cookies: true,
    localStorage: true,
    sessionStorage: true,
    indexedDB: true,
    serviceWorkers: true
  }
};

const $ = (id) => document.getElementById(id);

function showToast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

function setStatus(enabled) {
  const s = $("status");
  s.classList.toggle("active", enabled);
  s.classList.toggle("inactive", !enabled);
  s.querySelector(".status-text").textContent = enabled
    ? "Activo — limpiará al recargar"
    : "Desactivado";
}

async function load() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  $("enabled").checked = data.enabled;
  $("domains").value = data.domains;
  $("opt-cache").checked = data.opts.cache;
  $("opt-cookies").checked = data.opts.cookies;
  $("opt-localStorage").checked = data.opts.localStorage;
  $("opt-sessionStorage").checked = data.opts.sessionStorage;
  $("opt-indexedDB").checked = data.opts.indexedDB;
  $("opt-serviceWorkers").checked = data.opts.serviceWorkers;
  setStatus(data.enabled);
}

async function save() {
  const payload = {
    enabled: $("enabled").checked,
    domains: $("domains").value.trim(),
    opts: {
      cache: $("opt-cache").checked,
      cookies: $("opt-cookies").checked,
      localStorage: $("opt-localStorage").checked,
      sessionStorage: $("opt-sessionStorage").checked,
      indexedDB: $("opt-indexedDB").checked,
      serviceWorkers: $("opt-serviceWorkers").checked
    }
  };
  await chrome.storage.sync.set(payload);
  setStatus(payload.enabled);
  showToast("Guardado ✓");
}

$("enabled").addEventListener("change", save);
$("save").addEventListener("click", save);

[
  "opt-cache",
  "opt-cookies",
  "opt-localStorage",
  "opt-sessionStorage",
  "opt-indexedDB",
  "opt-serviceWorkers"
].forEach((id) => $(id).addEventListener("change", save));

$("domains").addEventListener("blur", save);

$("clear-now").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      showToast("No hay pestaña activa", true);
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "CLEAR_NOW",
      tabId: tab.id,
      url: tab.url
    });
    if (res?.ok) {
      showToast("Limpieza completada ✓");
    } else {
      showToast(res?.error || "Error al limpiar", true);
    }
  } catch (e) {
    showToast("Error: " + e.message, true);
  }
});

load();
