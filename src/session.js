// Historial de conversacion en memoria, por numero de telefono.
// NOTA: se pierde si el proceso se reinicia (deploy, crash). Para produccion
// seria bueno pasar esto a Redis o una tabla en base de datos, pero para un
// primer lanzamiento esto es suficiente.

const MAX_MESSAGES = 20; // mensajes (user+assistant) a retener por conversacion
const IDLE_TTL_MS = 1000 * 60 * 60 * 6; // 6 horas: pasado esto, se reinicia el contexto

const sessions = new Map(); // phone -> { messages: [...], lastActive: number }

function getSession(phone) {
  const existing = sessions.get(phone);
  if (existing && Date.now() - existing.lastActive < IDLE_TTL_MS) {
    return existing;
  }
  const fresh = { messages: [], lastActive: Date.now() };
  sessions.set(phone, fresh);
  return fresh;
}

function appendMessage(phone, role, content) {
  const session = getSession(phone);
  session.messages.push({ role, content });
  if (session.messages.length > MAX_MESSAGES) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES);
  }
  session.lastActive = Date.now();
  return session;
}

module.exports = { getSession, appendMessage };
