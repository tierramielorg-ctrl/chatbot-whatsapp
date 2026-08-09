require("dotenv").config();
const path = require("path");
const express = require("express");
const whatsapp = require("./whatsapp");
const claudeAgent = require("./claudeAgent");
const shopifyAuth = require("./shopifyAuth");
const shopifyWebhooks = require("./shopifyWebhooks");
const postPurchaseFlows = require("./postPurchaseFlows");

const app = express();

// Pagina publica de politica de privacidad (requerida por Meta para publicar la app)
app.use(express.static(path.join(__dirname, "..", "public")));

// Guardamos el rawBody para poder verificar la firma X-Hub-Signature-256
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.status(200).send("ok"));

// Flujo unico de instalacion OAuth para obtener el Admin API access token de Shopify.
// Uso: abrir /shopify/install?shop=tu-tienda.myshopify.com en el navegador (logueado en Shopify).
app.get("/shopify/install", shopifyAuth.install);
app.get("/shopify/callback", shopifyAuth.callback);

// Webhooks de Shopify para las automatizaciones post-compra.
app.post("/webhooks/shopify/orders-create", shopifyWebhooks.ordersCreate);
app.post("/webhooks/shopify/orders-updated", shopifyWebhooks.ordersUpdated);

// Meta llama este GET una vez, al configurar el webhook en el panel de la app.
app.get("/webhook", (req, res) => {
  const challenge = whatsapp.verifyWebhook(req.query);
  if (challenge) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta llama este POST cada vez que llega un mensaje/evento nuevo.
app.post("/webhook", async (req, res) => {
  const signature = req.get("X-Hub-Signature-256");
  if (!whatsapp.verifySignature(req.rawBody, signature)) {
    console.warn("Firma de webhook invalida, se descarta el request.");
    return res.sendStatus(401);
  }

  // Responder rapido 200 para que Meta no reintente; procesar despues.
  res.sendStatus(200);

  try {
    const message = whatsapp.parseIncomingMessage(req.body);
    if (!message) return; // eventos de status (delivered/read), etc: ignorar

    if (message.type !== "text" && !message.text) {
      await whatsapp.sendTextMessage(
        message.from,
        "Por ahora puedo leer solo mensajes de texto 🙂 ¿me cuentas en palabras qué necesitas?"
      );
      return;
    }

    whatsapp.markAsRead(message.id);

    const reply = await claudeAgent.handleMessage(message.from, message.text);
    await whatsapp.sendTextMessage(message.from, reply);
  } catch (err) {
    console.error("Error procesando mensaje entrante:", err);
    try {
      const message = whatsapp.parseIncomingMessage(req.body);
      if (message?.from) {
        await whatsapp.sendTextMessage(
          message.from,
          "Uy, tuve un problema técnico respondiéndote. ¿Puedes intentar de nuevo en un momento?"
        );
      }
    } catch {
      // no-op: ya logueamos el error original
    }
  }
});

// TEMPORAL: chequeo rapido de cuales variables de plantilla estan configuradas.
app.get("/debug-template-vars", (_req, res) => {
  res.json({
    WHATSAPP_TEMPLATE_PERSONALIZATION: process.env.WHATSAPP_TEMPLATE_PERSONALIZATION || null,
    WHATSAPP_TEMPLATE_USAGE: process.env.WHATSAPP_TEMPLATE_USAGE || null,
    WHATSAPP_TEMPLATE_WELCOME: process.env.WHATSAPP_TEMPLATE_WELCOME || null,
    WHATSAPP_TEMPLATE_TRACKING: process.env.WHATSAPP_TEMPLATE_TRACKING || null,
    WHATSAPP_TEMPLATE_LANG: process.env.WHATSAPP_TEMPLATE_LANG || null,
  });
});

// TEMPORAL: diagnostico del envio de plantilla. Borrar despues de usar.
app.get("/debug-send-test", async (req, res) => {
  const whatsapp = require("./whatsapp");
  const to = req.query.to;
  const templateName = req.query.template || process.env.WHATSAPP_TEMPLATE_PERSONALIZATION;
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || "(no configurado, usando default 'es')";
  try {
    const result = await fetch(
      `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v20.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: templateName,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "es" },
            components: [{ type: "body", parameters: [{ type: "text", text: "DebugTest" }] }],
          },
        }),
      }
    );
    const body = await result.json();
    res.json({ usedLang: lang, templateName, httpStatus: result.status, response: body });
  } catch (err) {
    res.json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tierra Miel WhatsApp bot escuchando en el puerto ${PORT}`);
});

// Revisa cada 30 minutos si hay pedidos a los que ya les toca el mensaje de modo de uso.
const USAGE_SCHEDULER_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  postPurchaseFlows.runUsageScheduler().catch((err) =>
    console.error("Error en runUsageScheduler:", err)
  );
}, USAGE_SCHEDULER_INTERVAL_MS);
