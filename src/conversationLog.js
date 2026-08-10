// Guarda el historial completo de conversaciones (para el panel de admin) y
// controla cuando el bot debe "callarse" porque Tierra Miel esta respondiendo
// manualmente. Vive en memoria del proceso - se pierde si el servicio se
// reinicia, pero en el plan Starter eso solo pasa cuando hacemos un deploy.

const PAUSE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 horas

const conversations = new Map(); // phone -> { name, messages: [...], pausedUntil: number|null }

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
  return convo;
}

function isPaused(phone) {
  const convo = conversations.get(phone);
  if (!convo || !convo.pausedUntil) return false;
  if (Date.now() > convo.pausedUntil) {
    convo.pausedUntil = null;
    return false;
  }
  return true;
}

function pause(phone, durationMs = PAUSE_DURATION_MS) {
  const convo = getOrCreate(phone);
  convo.pausedUntil = Date.now() + durationMs;
}

function resume(phone) {
  const convo = conversations.get(phone);
  if (convo) convo.pausedUntil = null;
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
