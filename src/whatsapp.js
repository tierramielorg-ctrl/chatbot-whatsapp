const crypto = require("crypto");

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";

/** Maneja el GET de verificacion que Meta hace al configurar el webhook. */
function verifyWebhook(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

/**
 * Verifica la firma X-Hub-Signature-256 del webhook usando el App Secret.
 * rawBody debe ser el Buffer/string sin parsear del body.
 */
function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) return true; // firma opcional si no se configuro el secret
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

/** Extrae el primer mensaje de texto entrante de un payload de webhook, si existe. */
function parseIncomingMessage(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  if (!message) return null;

  const contact = value.contacts?.[0];
  return {
    id: message.id,
    from: message.from, // numero de telefono del cliente (sin '+')
    name: contact?.profile?.name || null,
    type: message.type,
    text:
      message.type === "text"
        ? message.text.body
        : message.type === "button"
        ? message.button.text
        : message.type === "interactive"
        ? message.interactive?.button_reply?.title ||
          message.interactive?.list_reply?.title ||
          null
        : null,
  };
}

async function sendTextMessage(to, text) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text, preview_url: true },
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error("Error enviando mensaje de WhatsApp:", res.status, errText);
  }
  return res.ok;
}

/**
 * Manda un mensaje de plantilla aprobada por Meta (necesario para iniciar una
 * conversacion cuando el negocio escribe primero, ej. confirmacion de pedido).
 * variables: array de strings que llenan los {{1}}, {{2}}, etc del body de la plantilla.
 */
async function sendTemplateMessage(to, templateName, languageCode, variables = []) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode || "es" },
          components: variables.length
            ? [
                {
                  type: "body",
                  parameters: variables.map((v) => ({ type: "text", text: String(v) })),
                },
              ]
            : undefined,
        },
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error("Error enviando plantilla de WhatsApp:", res.status, errText);
  }
  return res.ok;
}

/**
 * Manda una pregunta con opciones tocables (botones si son <=3, lista si son 4-10).
 * Mucho mejor experiencia que escribir las opciones como texto plano.
 */
async function sendInteractiveQuestion(to, questionText, options) {
  const cleanOptions = options.slice(0, 10);
  let interactive;

  if (cleanOptions.length <= 3) {
    interactive = {
      type: "button",
      body: { text: questionText.slice(0, 1024) },
      action: {
        buttons: cleanOptions.map((opt, i) => ({
          type: "reply",
          reply: { id: `opt_${i + 1}`, title: opt.slice(0, 20) },
        })),
      },
    };
  } else {
    interactive = {
      type: "list",
      body: { text: questionText.slice(0, 1024) },
      action: {
        button: "Elegir opción",
        sections: [
          {
            title: "Opciones",
            rows: cleanOptions.map((opt, i) => ({ id: `opt_${i + 1}`, title: opt.slice(0, 24) })),
          },
        ],
      },
    };
  }

  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "interactive", interactive }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error("Error enviando pregunta interactiva de WhatsApp:", res.status, errText);
  }
  return res.ok;
}

/** Manda un audio (nota de voz) desde una URL publica (mp3/ogg/etc soportado por WhatsApp). */
async function sendAudioMessage(to, audioUrl) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "audio",
        audio: { link: audioUrl },
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error("Error enviando audio de WhatsApp:", res.status, errText);
  }
  return res.ok;
}

async function markAsRead(messageId) {
  try {
    await fetch(
      `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
        }),
      }
    );
  } catch (err) {
    console.error("Error marcando mensaje como leido:", err);
  }
}

module.exports = {
  verifyWebhook,
  verifySignature,
  parseIncomingMessage,
  sendTextMessage,
  sendTemplateMessage,
  sendInteractiveQuestion,
  sendAudioMessage,
  markAsRead,
};
