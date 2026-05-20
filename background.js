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

// Inicializa defaults al instalar
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  const merged = { ...DEFAULTS, ...current };
  await chrome.storage.sync.set(merged);
});

// Convierte un patrón ("localhost", "*.local", "dev.miweb.com") a regex
function patternToRegex(pattern) {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function hostMatches(hostname, domainsText) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  const patterns = domainsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const p of patterns) {
    const rx = patternToRegex(p);
    if (rx.test(host)) return true;
  }
  return false;
}

function getOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return null;
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Borra datos usando chrome.browsingData (caché, cookies, indexedDB, serviceWorkers, localStorage…)
async function clearBrowsingDataFor(origin, opts) {
  if (!origin) return;
  const dataToRemove = {
    cache: !!opts.cache,
    cookies: !!opts.cookies,
    localStorage: !!opts.localStorage,
    indexedDB: !!opts.indexedDB,
    serviceWorkers: !!opts.serviceWorkers,
    cacheStorage: !!opts.cache,
    fileSystems: !!opts.indexedDB,
    webSQL: !!opts.indexedDB
  };

  // chrome.browsingData filtra por "origins" para cookies/storage modernos
  await chrome.browsingData.remove(
    {
      origins: [origin],
      since: 0
    },
    dataToRemove
  );

  // Limpieza extra: cookies del dominio (browsingData a veces no las pilla en localhost)
  if (opts.cookies) {
    try {
      const hostname = new URL(origin).hostname;
      const cookies = await chrome.cookies.getAll({ domain: hostname }).catch(() => []);
      for (const c of cookies) {
        const protocol = c.secure ? "https://" : "http://";
        const cookieUrl = `${protocol}${c.domain.replace(/^\./, "")}${c.path}`;
        await chrome.cookies
          .remove({ url: cookieUrl, name: c.name, storeId: c.storeId })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
}

// Inyecta limpieza de sessionStorage en la pestaña (browsingData no lo borra)
async function clearSessionStorageInTab(tabId, opts) {
  if (!opts.sessionStorage && !opts.localStorage) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (clearSession, clearLocal) => {
        try {
          if (clearSession) window.sessionStorage.clear();
          if (clearLocal) window.localStorage.clear();
        } catch (e) {
          /* algunos contextos lo bloquean */
        }
      },
      args: [!!opts.sessionStorage, !!opts.localStorage]
    });
  } catch {
    /* la pestaña puede ser chrome:// u otra restringida */
  }
}

async function shouldHandle(url) {
  if (!url) return false;
  if (!/^https?:/i.test(url)) return false;
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  if (!cfg.enabled) return false;
  const host = getHostname(url);
  if (!hostMatches(host, cfg.domains)) return false;
  return cfg;
}

// Hook principal: ANTES de que la pestaña navegue/recargue (sólo frame principal)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const cfg = await shouldHandle(details.url);
  if (!cfg) return;

  const origin = getOrigin(details.url);
  await clearBrowsingDataFor(origin, cfg.opts);
  // sessionStorage/localStorage en la pestaña *antes* de que cargue el nuevo doc:
  // intentamos en la pestaña actual (todavía contiene el documento previo)
  await clearSessionStorageInTab(details.tabId, cfg.opts);
});

// Mensaje del popup: "Borrar ahora"
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "CLEAR_NOW") {
      try {
        const cfg = await chrome.storage.sync.get(DEFAULTS);
        const origin = getOrigin(msg.url);
        if (!origin) {
          sendResponse({ ok: false, error: "URL inválida" });
          return;
        }
        await clearBrowsingDataFor(origin, cfg.opts);
        await clearSessionStorageInTab(msg.tabId, cfg.opts);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }
  })();
  return true; // async response
});
