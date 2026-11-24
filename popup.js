const $ = (s) => document.querySelector(s);
const ICON = { image: "🖼", video: "🎬", gif: "🎞", audio: "🎵", sticker: "🧩" };
let items = [];
let tabId = null;

const status = (t) => ($("#status").textContent = t);
const activeTypes = () => [...document.querySelectorAll("#filters input:checked")].map((i) => i.value);

async function send(msg) {
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("https://web.telegram.org/")) throw new Error("Abrí web.telegram.org en esta pestaña.");
    tabId = tab.id;
  }
  return chrome.tabs.sendMessage(tabId, msg);
}

function render() {
  const types = activeTypes();
  const visible = items.filter((i) => types.includes(i.type));
  const list = $("#list");
  list.innerHTML = "";
  visible.forEach((it) => {
    const row = document.createElement("div");
    row.className = "item";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = it.selected !== false;
    cb.onchange = () => (it.selected = cb.checked);
    let thumb;
    if ((it.type === "image" || it.type === "sticker") && !it.url.startsWith("blob:")) {
      thumb = document.createElement("img"); thumb.src = it.url;
    } else {
      thumb = document.createElement("div"); thumb.textContent = ICON[it.type];
    }
    thumb.className = "thumb";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span class="tag">${ICON[it.type]} ${it.type}</span>
      <div class="muted">${it.width && it.height ? it.width + "×" + it.height + " · " : ""}msg ${it.mid || "?"}</div>`;
    const btn = document.createElement("button");
    btn.textContent = "⬇"; btn.style.flex = "none"; btn.style.width = "36px";
    btn.onclick = () => downloadItems([it]);
    row.append(cb, thumb, meta, btn);
    list.appendChild(row);
  });
  $("#all").disabled = visible.length === 0;
  status(`${visible.length} archivo(s) encontrados.`);
}

async function scan() {
  status("Escaneando…");
  try {
    const res = await send({ cmd: "scan" });
    items = res.items;
    render();
  } catch (e) {
    status(e.message.includes("Receiving end") ? "Recargá la pestaña de Telegram y probá de nuevo." : e.message);
  }
}

async function downloadItems(list) {
  if (!list.length) return;
  status(`Descargando ${list.length}…`);
  try {
    const { results } = await send({ cmd: "download", items: list });
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    status(`✓ ${ok} descargado(s)${fail ? ` · ✕ ${fail} con error (abrilos en el visor y reintentá)` : ""}.`);
  } catch (e) { status("Error: " + e.message); }
}

$("#scan").onclick = scan;
$("#backup").onclick = async () => {
  try {
    await send({ cmd: "backup" });
    status("Backup iniciado: mirá el progreso abajo en la pestaña de Telegram. Podés cerrar este popup.");
  } catch (e) { status(e.message.includes("Receiving end") ? "Recargá la pestaña de Telegram y probá de nuevo." : e.message); }
};
$("#all").onclick = () => {
  const types = activeTypes();
  downloadItems(items.filter((i) => types.includes(i.type) && i.selected !== false));
};
document.querySelectorAll("#filters input").forEach((i) => (i.onchange = () => {
  chrome.storage.local.set({ filters: activeTypes() });
  render();
}));

chrome.storage.local.get("filters").then(({ filters }) => {
  if (filters) document.querySelectorAll("#filters input").forEach((i) => (i.checked = filters.includes(i.value)));
  scan();
});
