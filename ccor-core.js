// Lógica compartida de CCoR (service worker, popup y tests)
const CCOR_DEFAULTS = {
  enabled: true,
  mode: "allow", // "allow": solo sitios permitidos | "block": todos menos los bloqueados
  allowList: "localhost\n127.0.0.1\n*.local\n0.0.0.0",
  blockList: "",
  trigger: "reload", // "reload": solo recargas (transitionType reload) | "navigation": cada navegación
  opts: {
    cache: true,
    cookies: true,
    localStorage: true,
    sessionStorage: true,
    indexedDB: true,
    serviceWorkers: true
  },
  stats: { count: 0, lastHost: "", lastAt: 0, lastError: "", lastNote: "" }
};

// Sugerencia opcional: el usuario la añade a su lista bloqueada con un botón
const CCOR_SUGGESTED_BLOCK = ["accounts.google.com", "*.paypal.com"];

// Lee una lista: una entrada por línea, "#" comentarios, acepta URLs completas
function parseList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim().toLowerCase())
    .filter(Boolean)
    .map((l) => l.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, ""))
    .filter(Boolean);
}

// "*.web.com" cubre subdominios y el dominio base; "web.com" solo ese host
function patternToRegex(pattern) {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2).replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
    return new RegExp("^(?:.+\\.)?" + base + "$");
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function hostMatches(hostname, patterns) {
  return matchingRule(hostname, patterns) !== null;
}

function matchingRule(hostname, patterns) {
  if (!hostname) return null;
  const host = hostname.toLowerCase();
  return patterns.find((p) => patternToRegex(p).test(host)) || null;
}

// Devuelve { act, reason, rule }
function decide(hostname, cfg) {
  if (!cfg.enabled) return { act: false, reason: "disabled", rule: null };
  const blocked = matchingRule(hostname, parseList(cfg.blockList));
  if (blocked) return { act: false, reason: "blocked", rule: blocked };
  if (cfg.mode === "block") return { act: true, reason: "not-blocked", rule: null };
  const allowed = matchingRule(hostname, parseList(cfg.allowList));
  return allowed
    ? { act: true, reason: "allowed", rule: allowed }
    : { act: false, reason: "not-allowed", rule: null };
}

// Si el host es subdominio de una regla sin "*." devuelve esa regla (para avisar al usuario)
function subdomainTip(hostname, patterns) {
  const host = (hostname || "").toLowerCase();
  return patterns.find((p) => !p.includes("*") && host.endsWith("." + p)) || null;
}

if (typeof module !== "undefined") {
  module.exports = { CCOR_DEFAULTS, CCOR_SUGGESTED_BLOCK, parseList, patternToRegex, hostMatches, matchingRule, decide, subdomainTip };
}
