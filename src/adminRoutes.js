const express = require("express");
const whatsapp = require("./whatsapp");
const conversationLog = require("./conversationLog");
const { requireAdminAuth } = require("./adminAuth");

const router = express.Router();
router.use(requireAdminAuth);

router.get("/api/conversations", (_req, res) => {
  res.json(conversationLog.listConversations());
});

router.get("/api/conversations/:phone", (req, res) => {
  const convo = conversationLog.getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ error: "No se encontro esa conversacion." });
  res.json(convo);
});

router.post("/api/conversations/:phone/reply", async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "Falta el texto del mensaje." });

  const sent = await whatsapp.sendTextMessage(phone, text);
  if (!sent) return res.status(502).json({ error: "No se pudo enviar el mensaje por WhatsApp." });

  conversationLog.logMessage(phone, "out", text);
  conversationLog.pause(phone);
  res.json({ ok: true });
});

router.post("/api/conversations/:phone/resume", (req, res) => {
  conversationLog.resume(req.params.phone);
  res.json({ ok: true });
});

router.get("/", (_req, res) => {
  res.type("html").send(ADMIN_HTML);
});

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Tierra Miel — Conversaciones</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; display: flex; height: 100vh; background: #faf6f0; }
  #list { width: 320px; min-width: 260px; border-right: 1px solid #e5ddd0; overflow-y: auto; background: #fff; }
  #list h1 { font-size: 1.1em; padding: 16px; margin: 0; border-bottom: 1px solid #e5ddd0; background: #f3ead9; }
  .convo-item { padding: 12px 16px; border-bottom: 1px solid #f0ebe1; cursor: pointer; }
  .convo-item:hover { background: #f7f1e6; }
  .convo-item.active { background: #f0e4cc; }
  .convo-item .name { font-weight: 600; font-size: 0.95em; }
  .convo-item .preview { font-size: 0.85em; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .convo-item .badge { display: inline-block; background: #d97706; color: white; font-size: 0.7em; padding: 1px 6px; border-radius: 10px; margin-left: 6px; }
  #chat { flex: 1; display: flex; flex-direction: column; }
  #chat-header { padding: 14px 20px; border-bottom: 1px solid #e5ddd0; background: #fff; display: flex; justify-content: space-between; align-items: center; }
  #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 65%; padding: 8px 12px; border-radius: 10px; font-size: 0.92em; line-height: 1.4; }
  .msg.in { align-self: flex-start; background: #fff; border: 1px solid #eee; }
  .msg.out { align-self: flex-end; background: #dcf8c6; }
  .msg .time { display: block; font-size: 0.7em; color: #999; margin-top: 4px; }
  #compose { display: flex; gap: 8px; padding: 14px 20px; border-top: 1px solid #e5ddd0; background: #fff; }
  #compose input { flex: 1; padding: 10px 14px; border-radius: 20px; border: 1px solid #ddd; font-size: 0.95em; }
  #compose button { padding: 10px 20px; border-radius: 20px; border: none; background: #d97706; color: white; font-weight: 600; cursor: pointer; }
  #compose button:disabled { opacity: 0.5; cursor: default; }
  .btn-secondary { padding: 6px 14px; border-radius: 16px; border: 1px solid #d97706; background: white; color: #d97706; font-size: 0.85em; cursor: pointer; }
  #empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #999; }
</style>
</head>
<body>
  <div id="list">
    <h1>🍯 Conversaciones <button id="new-convo-btn" class="btn-secondary" style="float:right;margin-top:-4px;" onclick="startNewConvo()">+ Nuevo</button></h1>
    <div id="convo-list"></div>
  </div>
  <div id="chat">
    <div id="empty">Selecciona una conversación de la izquierda</div>
  </div>

<script>
let activePhone = null;
let pollTimer = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error("Error de red: " + res.status);
  return res.json();
}

function timeAgo(ts) {
  const d = new Date(ts);
  return d.toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function loadList() {
  const list = await api("/admin/api/conversations");
  const el = document.getElementById("convo-list");
  el.innerHTML = list.map(c => \`
    <div class="convo-item \${c.phone === activePhone ? 'active' : ''}" onclick="openConvo('\${c.phone}')">
      <div class="name">\${c.name || c.phone} \${c.paused ? '<span class="badge">Pausado</span>' : ''}</div>
      <div class="preview">\${c.lastDirection === 'out' ? '↳ ' : ''}\${(c.lastMessage || '').slice(0, 60)}</div>
    </div>
  \`).join("") || '<div style="padding:16px;color:#999">Todavía no hay conversaciones.</div>';
}

async function openConvo(phone) {
  activePhone = phone;
  await loadList();
  const convo = await api("/admin/api/conversations/" + encodeURIComponent(phone));
  renderChat(convo);
}

/** Normaliza un numero chileno ingresado a mano (con o sin +56, espacios, guiones). */
function normalizePhoneInput(raw) {
  let digits = (raw || "").replace(/[^0-9]/g, "");
  if (digits.length === 9 && digits.startsWith("9")) digits = "56" + digits;
  return digits;
}

/** Inicia una conversacion con un numero que todavia no aparece en la lista (no tiene historial). */
function startNewConvo() {
  const raw = prompt("Numero de WhatsApp del cliente (con o sin +56):");
  if (!raw) return;
  const phone = normalizePhoneInput(raw);
  if (phone.length < 10) {
    alert("Ese numero no se ve valido. Ejemplo: +56 9 1234 5678");
    return;
  }
  activePhone = phone;
  renderChat({ phone, name: null, messages: [], paused: false });
}

function renderChat(convo) {
  document.getElementById("chat").innerHTML = \`
    <div id="chat-header">
      <div><strong>\${convo.name || convo.phone}</strong><div style="font-size:0.8em;color:#888">\${convo.phone}</div></div>
      <button class="btn-secondary" onclick="toggleResume('\${convo.phone}', \${convo.paused})">\${convo.paused ? '▶ Reanudar bot' : '⏸ Bot activo'}</button>
    </div>
    <div id="messages">
      \${convo.messages.map(m => \`
        <div class="msg \${m.direction}">
          \${(m.text || '').replace(/</g,'&lt;')}
          <span class="time">\${timeAgo(m.timestamp)}</span>
        </div>
      \`).join("")}
    </div>
    <div id="compose">
      <input id="reply-input" type="text" placeholder="Escribe tu respuesta..." onkeydown="if(event.key==='Enter') sendReply('\${convo.phone}')" />
      <button onclick="sendReply('\${convo.phone}')">Enviar</button>
    </div>
  \`;
  const msgs = document.getElementById("messages");
  msgs.scrollTop = msgs.scrollHeight;
}

async function sendReply(phone) {
  const input = document.getElementById("reply-input");
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    await api("/admin/api/conversations/" + encodeURIComponent(phone) + "/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    input.value = "";
    const convo = await api("/admin/api/conversations/" + encodeURIComponent(phone));
    renderChat(convo);
  } catch (e) {
    alert("No se pudo enviar: " + e.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function toggleResume(phone, isPaused) {
  if (!isPaused) return; // "Bot activo" no es un boton de accion
  await api("/admin/api/conversations/" + encodeURIComponent(phone) + "/resume", { method: "POST" });
  const convo = await api("/admin/api/conversations/" + encodeURIComponent(phone));
  renderChat(convo);
  loadList();
}

loadList();
pollTimer = setInterval(async () => {
  await loadList();
  if (activePhone) {
    const convo = await api("/admin/api/conversations/" + encodeURIComponent(activePhone));
    renderChat(convo);
  }
}, 8000);
</script>
</body>
</html>`;

module.exports = router;
