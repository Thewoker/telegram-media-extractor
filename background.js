// Registra las descargas que inicia Chrome para que el content script pueda verificar que ocurrieron
let log = [];
chrome.downloads.onCreated.addListener((d) => {
  log.push({ t: Date.now(), name: d.filename || d.finalUrl || d.url, mime: d.mime || "" });
  if (log.length > 200) log = log.slice(-100);
});
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.cmd === "downloadsSince") reply({ items: log.filter((d) => d.t >= msg.t) });
});
