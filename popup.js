const $ = (id) => document.getElementById(id);
let currentMode = "allow";
let currentTrigger = "reload";
let currentList = "allow";

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
  s.querySelector(".status-text").textContent = enabled ? "Activo: limpiará al recargar" : "Desactivado";
}

const TRIGGER_HINT = {
  reload: "Al recargar: borra y recarga la página una vez más (si cargarla por GET tiene efectos, se pide 2 veces). No actúa en páginas cargadas con POST ni en location.reload() de la propia página.",
  navigation: "En cada navegación: borra antes de cargar cualquier página del sitio, también al cambiar de URL, seguir enlaces o enviar formularios. Sin recarga extra."
};

function setTrigger(t) {
  currentTrigger = t;
  $("trigger-hint").textContent = TRIGGER_HINT[t];
  document.querySelectorAll("#trigger button").forEach((b) => b.classList.toggle("on", b.dataset.trigger === t));
}

function setList(l) {
  currentList = l;
  document.querySelectorAll("#lists button").forEach((b) => b.classList.toggle("on", b.dataset.list === l));
  $("allowList").style.display = l === "allow" ? "block" : "none";
  $("blockList").style.display = l === "block" ? "block" : "none";
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Dice qué pasaría con la pestaña actual
async function refreshSiteHint() {
  const tab = await activeTab();
  const host = tab?.url && /^https?:/i.test(tab.url) ? new URL(tab.url).hostname : null;
  const el = $("site-hint");
  if (!host) { el.textContent = "Esta pestaña no es una web (http/https)."; return; }
  const cfg = collect();
  const d = decide(host, cfg);
  const why = { disabled: "CCoR está desactivado", blocked: `bloqueado por la regla ${d.rule}`,
    "not-blocked": "ninguna regla lo bloquea", allowed: `permitido por la regla ${d.rule}`,
    "not-allowed": "no coincide con la lista permitida" }[d.reason];
  let text = `${host}: ${d.act ? "se limpiará" : "no se limpiará"} (${why}).`;
  const list = parseList(d.reason === "not-allowed" ? cfg.allowList : cfg.blockList);
  const tip = !d.rule && subdomainTip(host, list);
  if (tip) text += ` "${tip}" solo cubre ese host; usa "*.${tip}" para incluir subdominios.`;
  el.textContent = text;
}

function collect() {
  return {
    enabled: $("enabled").checked,
    mode: currentMode,
    allowList: $("allowList").value.trim(),
    blockList: $("blockList").value.trim(),
    trigger: currentTrigger,
    opts: {
      cache: $("opt-cache").checked,
      cookies: $("opt-cookies").checked,
      localStorage: $("opt-localStorage").checked,
      sessionStorage: $("opt-sessionStorage").checked,
      indexedDB: $("opt-indexedDB").checked,
      serviceWorkers: $("opt-serviceWorkers").checked
    }
  };
}

async function load() {
  const data = await chrome.storage.sync.get(CCOR_DEFAULTS);
  const { stats } = await chrome.storage.local.get({ stats: CCOR_DEFAULTS.stats });
  $("enabled").checked = data.enabled;
  $("allowList").value = data.allowList;
  $("blockList").value = data.blockList;
  setTrigger(data.trigger);
  for (const k of Object.keys(CCOR_DEFAULTS.opts)) $("opt-" + k).checked = data.opts[k];
  setMode(data.mode);
  setList(data.mode === "block" ? "block" : "allow");
  setStatus(data.enabled);
  $("stats").textContent = stats.count ? `${stats.count} limpiezas · última: ${stats.lastHost}` : "v2.0.0";
  $("error").textContent = stats.lastError ? `Último error: ${stats.lastError}` : "";
  $("note").textContent = stats.lastNote || "";
  await refreshSiteHint();
}

async function save() {
  const payload = collect();
  await chrome.storage.sync.set(payload);
  setStatus(payload.enabled);
  await refreshSiteHint();
  showToast("Guardado ✓");
}

async function addCurrent(listId) {
  const tab = await activeTab();
  if (!tab?.url || !/^https?:/i.test(tab.url)) return showToast("No hay web activa", true);
  const host = new URL(tab.url).hostname;
  setList(listId === "allowList" ? "allow" : "block");
  const el = $(listId);
  const items = parseList(el.value);
  if (!items.includes(host)) el.value = (el.value.trim() + "\n" + host).trim();
  await save();
}

$("enabled").addEventListener("change", save);
$("save").addEventListener("click", save);
document.querySelectorAll("#trigger button").forEach((b) =>
  b.addEventListener("click", () => { setTrigger(b.dataset.trigger); save(); })
);
Object.keys(CCOR_DEFAULTS.opts).forEach((k) => $("opt-" + k).addEventListener("change", () => {
  if (k === "cookies" && $("opt-cookies").checked && !confirm("Cookies: se borrarán también las compartidas con el dominio padre y pueden cerrar sesión en otros subdominios. ¿Activar?")) {
    $("opt-cookies").checked = false;
    return;
  }
  save();
}));
["allowList", "blockList"].forEach((id) => $(id).addEventListener("blur", save));
document.querySelectorAll("#mode button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.mode === "block" && currentMode !== "block" && !confirm("Todos menos bloqueados: CCoR limpiará los datos elegidos de TODOS los sitios que no estén en la lista bloqueada (cookies incluidas, lo que puede cerrar sesiones). ¿Continuar?")) return;
    setMode(b.dataset.mode); save();
  })
);
$("suggest-block").addEventListener("click", async () => {
  const el = $("blockList");
  const have = parseList(el.value);
  const add = CCOR_SUGGESTED_BLOCK.filter((p) => !have.includes(p));
  if (add.length) el.value = (el.value.trim() + "\n" + add.join("\n")).trim();
  setList("block");
  await save();
});
document.querySelectorAll("#lists button").forEach((b) => b.addEventListener("click", () => setList(b.dataset.list)));
$("add-allow").addEventListener("click", () => addCurrent("allowList"));
$("add-block").addEventListener("click", () => addCurrent("blockList"));

$("clear-now").addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    if (!tab?.url) return showToast("No hay pestaña activa", true);
    const res = await chrome.runtime.sendMessage({ type: "CLEAR_NOW", tabId: tab.id, url: tab.url });
    if (res?.ok) showToast("Limpieza completada ✓");
    else showToast(res?.error || "Error al limpiar", true);
  } catch (e) {
    showToast("Error: " + e.message, true);
  }
});

load();
