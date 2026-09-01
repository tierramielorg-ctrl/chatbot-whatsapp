// Historial de conversacion en memoria, por numero de telefono.
// NOTA: se pierde si el proceso se reinicia (deploy, crash). Para produccion
// seria bueno pasar esto a Redis o una tabla en base de datos, pero para un
// primer lanzamiento esto es suficiente.

const MAX_MESSAGES = 20; // mensajes (user+assistant) a retener por conversacion
const IDLE_TTL_MS = 1000 * 60 * 60 * 6; // 6 horas: pasado esto, se reinicia el contexto

const sessions = new Map(); // phone -> { messages: [...], lastActive: number }

/**
 * origin: "main" (linea de atencion normal) o "ventas" (linea dedicada a campanas,
 * ej. anuncios "Click to WhatsApp"). Solo se usa para decidir el origin de una
 * conversacion NUEVA - una vez creada, la conversacion mantiene su origin aunque
 * este parametro cambie en llamadas futuras (no debería pasar en la práctica).
 */
function getSession(phone, origin = "main") {
  const existing = sessions.get(phone);
  if (existing && Date.now() - existing.lastActive < IDLE_TTL_MS) {
    return existing;
  }
  const fresh = {
    messages: [],
    lastActive: Date.now(),
    mode: "normal",
    orderId: null,
    orderName: null,
    origin,
  };
  sessions.set(phone, fresh);
  return fresh;
}

/**
 * Pone una conversacion en un modo especial (ej "personalization" o "usage"),
 * asociada a un pedido especifico. El proximo mensaje que llegue de ese numero
 * va a usar el system prompt y las herramientas de ese modo en vez del normal.
 */
function setSessionMode(phone, mode, orderId, orderName) {
  const session = getSession(phone);
  session.mode = mode;
  session.orderId = orderId;
  session.orderName = orderName;
  session.lastActive = Date.now();
  return session;
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

module.exports = { getSession, appendMessage, setSessionMode };
