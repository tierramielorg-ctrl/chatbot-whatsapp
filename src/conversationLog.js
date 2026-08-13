// Guarda el historial completo de conversaciones (para el panel de admin) y
// controla cuando el bot debe "callarse" porque Tierra Miel esta respondiendo
// manualmente.
//
// Persistencia: ademas de vivir en memoria (rapido), cada cambio se guarda en
// un archivo JSON en disco. Si DATA_DIR apunta a un Disco persistente de
// Render (recomendado: montado en /data), el historial sobrevive reinicios y
// redeploys. Si no hay Disco configurado, igual escribe en el filesystem local
// del contenedor (se pierde en el proximo deploy, pero no entre requests).

const fs = require("fs");
const path = require("path");

const PAUSE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 horas

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "conversations.json");

const conversations = new Map(); // phone -> { name, messages: [...], pausedUntil: number|null }

function loadFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    for (const [phone, convo] of Object.entries(parsed)) {
      conversations.set(phone, convo);
    }
    console.log(`conversationLog: ${conversations.size} conversaciones cargadas desde ${DATA_FILE}.`);
  } catch (err) {
    console.error("conversationLog: error cargando historial desde disco:", err);
  }
}

let saving = false;
let saveQueued = false;

function saveToDisk() {
  // Evita escrituras superpuestas si llegan varios mensajes muy seguidos.
  if (saving) {
    saveQueued = true;
    return;
  }
  saving = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(conversations);
    // Escritura atomica: primero a un archivo temporal, despues rename.
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(obj));
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error("conversationLog: error guardando historial en disco:", err);
  } finally {
    saving = false;
    if (saveQueued) {
      saveQueued = false;
      saveToDisk();
    }
  }
}

loadFromDisk();

function getOrCreate(phone) {
  let convo = conversations.get(phone);
  if (!convo) {
    convo = { name: null, messages: [], pausedUntil: null };
    conversations.set(phone, convo);
  }
  return convo;
}

/** direction: "in" (del cliente) o "out" (del bot o de Tierra Miel manual). */
function logMessage(phone, direction, text, name) {
  const convo = getOrCreate(phone);
  if (name) convo.name = name;
  convo.messages.push({ direction, text, timestamp: Date.now() });
  if (convo.messages.length > 200) convo.messages.splice(0, convo.messages.length - 200);
  saveToDisk();
  return convo;
}

function isPaused(phone) {
  const convo = conversations.get(phone);
  if (!convo || !convo.pausedUntil) return false;
  if (Date.now() > convo.pausedUntil) {
    convo.pausedUntil = null;
    saveToDisk();
    return false;
  }
  return true;
}

function pause(phone, durationMs = PAUSE_DURATION_MS) {
  const convo = getOrCreate(phone);
  convo.pausedUntil = Date.now() + durationMs;
  saveToDisk();
}

function resume(phone) {
  const convo = conversations.get(phone);
  if (convo) {
    convo.pausedUntil = null;
    saveToDisk();
  }
}

/** Lista de conversaciones ordenadas por actividad mas reciente, para el panel. */
function listConversations() {
  return [...conversations.entries()]
    .map(([phone, convo]) => {
      const last = convo.messages[convo.messages.length - 1];
      return {
        phone,
        name: convo.name,
        lastMessage: last?.text || "",
        lastDirection: last?.direction || null,
        lastTimestamp: last?.timestamp || 0,
        paused: isPaused(phone),
      };
    })
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

function getConversation(phone) {
  const convo = conversations.get(phone);
  if (!convo) return null;
  return { phone, name: convo.name, messages: convo.messages, paused: isPaused(phone) };
}

module.exports = { logMessage, isPaused, pause, resume, listConversations, getConversation };
