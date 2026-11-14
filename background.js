importScripts("ccor-core.js");

async function getCfg() {
  const cfg = await chrome.storage.sync.get(null);
  const local = await chrome.storage.local.get({ stats: CCOR_DEFAULTS.stats });
  return { ...CCOR_DEFAULTS, ...cfg, opts: { ...CCOR_DEFAULTS.opts, ...(cfg.opts || {}) }, stats: local.stats };
}

// Migra la lista antigua "domains" a allowList
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  const merged = { ...CCOR_DEFAULTS, ...current };
  if (current.domains && !current.allowList) merged.allowList = current.domains;
  // Quien venía de la 1.0 mantiene su comportamiento (limpiar en cada navegación)
  if (current.domains && !current.trigger) merged.trigger = "navigation";
  delete merged.onlyReload;
  delete merged.domains;
  delete merged.stats;
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set(merged);
  updateBadge(merged.enabled);
});

chrome.runtime.onStartup.addListener(async () => updateBadge((await getCfg()).enabled));

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
}

function getOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function getHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// Borra los datos del origen con chrome.browsingData (caché y storage por origen)
async function clearBrowsingDataFor(origin, opts) {
  if (!origin) return;
  const dataToRemove = {
    cache: !!opts.cache,
    localStorage: !!opts.localStorage,
    indexedDB: !!opts.indexedDB,
    serviceWorkers: !!opts.serviceWorkers,
    cacheStorage: !!opts.cache,
    fileSystems: !!opts.indexedDB,
    webSQL: !!opts.indexedDB
  };
  await chrome.browsingData.remove({ origins: [origin], since: 0 }, dataToRemove);

  // browsingData borra cookies de todo el sitio (hermanos incluidos): se borran aparte
  // solo las cookies que el navegador enviaría a esta URL
  if (opts.cookies) {
    const cookies = await chrome.cookies.getAll({ url: origin + "/" });
    for (const c of cookies) {
      const cookieUrl = `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`;
      await chrome.cookies.remove({ url: cookieUrl, name: c.name, storeId: c.storeId });
    }
  }
}

// sessionStorage no lo borra browsingData: se limpia dentro de la pestaña
async function clearStorageInTab(tabId, opts, origin) {
  if (!opts.sessionStorage && !opts.localStorage) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (clearSession, clearLocal, expectedOrigin) => {
        // El documento actual puede ser el de OTRO sitio (se está saliendo de él): no tocarlo
        if (location.origin !== expectedOrigin) return;
        try {
          if (clearSession) window.sessionStorage.clear();
          if (clearLocal) window.localStorage.clear();
        } catch { /* contexto bloqueado */ }
      },
      args: [!!opts.sessionStorage, !!opts.localStorage, origin]
    });
  } catch { /* pestaña restringida */ }
}

async function recordStat(host) {
  const { stats } = await chrome.storage.local.get({ stats: CCOR_DEFAULTS.stats });
  await chrome.storage.local.set({ stats: { ...stats, count: stats.count + 1, lastHost: host, lastAt: Date.now(), lastError: "" } });
}

async function recordNote(host, note) {
  const { stats } = await chrome.storage.local.get({ stats: CCOR_DEFAULTS.stats });
  await chrome.storage.local.set({ stats: { ...stats, lastNote: `${host}: ${note}` } });
}

async function recordError(host, e) {
  const { stats } = await chrome.storage.local.get({ stats: CCOR_DEFAULTS.stats });
  await chrome.storage.local.set({ stats: { ...stats, lastError: `${host}: ${e && e.message ? e.message : e}`, lastAt: Date.now() } });
}

async function runClear(details, cfg, host) {
  try {
    await clearBrowsingDataFor(getOrigin(details.url), cfg.opts);
    await clearStorageInTab(details.tabId, cfg.opts, getOrigin(details.url));
    await recordStat(host);
    return true;
  } catch (e) {
    await recordError(host, e);
    return false;
  }
}

// Modo "navigation": antes de cada navegación del frame principal
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0 || !/^https?:/i.test(details.url)) return;
  const cfg = await getCfg();
  if (cfg.trigger !== "navigation") return;
  const host = getHostname(details.url);
  if (!decide(host, cfg).act) return;
  await runClear(details, cfg, host);
});

// Método de la última petición principal de cada pestaña (para no repetir un POST)
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { chrome.storage.session.set({ ["m-" + d.tabId]: d.method }); },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }
);

// Modo "reload": transitionType solo existe en onCommitted. Se borra y se recarga una vez
// más (sin caché); esa segunda carga lleva una marca para no entrar en bucle
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !/^https?:/i.test(details.url)) return;
  if (details.transitionType !== "reload") return;
  const cfg = await getCfg();
  if (cfg.trigger !== "reload") return;
  const key = "self-" + details.tabId;
  const mark = (await chrome.storage.session.get(key))[key];
  if (mark && Date.now() - mark < 5000) {
    await chrome.storage.session.remove(key);
    return;
  }
  const host = getHostname(details.url);
  if (!decide(host, cfg).act) return;
  // Una recarga extra de una página cargada con POST repetiría el envío: no se toca
  const method = (await chrome.storage.session.get("m-" + details.tabId))["m-" + details.tabId];
  if (method !== "GET") {
    await recordNote(host, "recarga de una página enviada con " + (method || "método desconocido") + ": no se limpia");
    return;
  }
  if (await runClear(details, cfg, host)) {
    await chrome.storage.session.set({ [key]: Date.now() });
    await chrome.tabs.reload(details.tabId, { bypassCache: true }).catch(() => chrome.storage.session.remove(key));
  }
});

// Si la recarga propia no llega a confirmarse (error, cancelada), se retira la marca
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId === 0) chrome.storage.session.remove("self-" + d.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(["self-" + tabId, "m-" + tabId]));

// Atajo de teclado: activar o desactivar
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-ccor") return;
  const { enabled } = await getCfg();
  await chrome.storage.sync.set({ enabled: !enabled });
  updateBadge(!enabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) updateBadge(changes.enabled.newValue);
});

// Mensajes del popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type !== "CLEAR_NOW") return;
    try {
      const cfg = await getCfg();
      const origin = getOrigin(msg.url);
      if (!origin) return sendResponse({ ok: false, error: "URL inválida" });
      if (!/^https?:/i.test(msg.url)) return sendResponse({ ok: false, error: "Solo páginas http/https" });
      await clearBrowsingDataFor(origin, cfg.opts);
      await clearStorageInTab(msg.tabId, cfg.opts, origin);
      await recordStat(getHostname(msg.url));
      sendResponse({ ok: true });
    } catch (e) {
      await recordError(getHostname(msg.url), e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
