require("dotenv").config();
const path = require("path");
const express = require("express");
const whatsapp = require("./whatsapp");
const claudeAgent = require("./claudeAgent");
const shopifyAuth = require("./shopifyAuth");
const shopifyWebhooks = require("./shopifyWebhooks");
const postPurchaseFlows = require("./postPurchaseFlows");
const conversationLog = require("./conversationLog");
const adminRoutes = require("./adminRoutes");
const trackingRoutes = require("./trackingRoutes");

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

// Panel privado para ver conversaciones y responder manualmente.
app.use("/admin", adminRoutes);

// Endpoint publico para la pagina "Seguimiento de tu pedido" del sitio.
app.use("/api", trackingRoutes);

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

    conversationLog.logMessage(message.from, "in", message.text, message.name);

    if (conversationLog.isPaused(message.from)) {
      // Tierra Miel esta respondiendo manualmente esta conversacion - el bot no interviene.
      console.log(`Conversacion con ${message.from} pausada, el bot no responde.`);
      return;
    }

    whatsapp.markAsRead(message.id, message.phoneNumberId);

    const reply = await claudeAgent.handleMessage(message.from, message.text, {
      phoneNumberId: message.phoneNumberId,
      referral: message.referral,
    });
    // reply vacio = una herramienta (ej pregunta interactiva) ya le mando algo
    // al cliente directamente, no hay texto adicional que mandar.
    if (reply) {
      await whatsapp.sendTextMessage(message.from, reply, message.phoneNumberId);
      conversationLog.logMessage(message.from, "out", reply);
    }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tierra Miel WhatsApp bot escuchando en el puerto ${PORT}`);
  // Corre la red de seguridad apenas arranca (ej. tras un reinicio), no solo cada 30 min.
  postPurchaseFlows.runOrderCatchupScheduler().catch((err) =>
    console.error("Error en runOrderCatchupScheduler (arranque):", err)
  );
  postPurchaseFlows.runContestCatchupScheduler().catch((err) =>
    console.error("Error en runContestCatchupScheduler (arranque):", err)
  );
  postPurchaseFlows.runSeptiembreCatchupScheduler().catch((err) =>
    console.error("Error en runSeptiembreCatchupScheduler (arranque):", err)
  );
});

// Revisa cada 30 minutos si hay pedidos a los que ya les toca el mensaje de modo de uso,
// o el recordatorio de resena + descuento.
const USAGE_SCHEDULER_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  postPurchaseFlows.runUsageScheduler().catch((err) =>
    console.error("Error en runUsageScheduler:", err)
  );
  postPurchaseFlows.runReviewScheduler().catch((err) =>
    console.error("Error en runReviewScheduler:", err)
  );
  postPurchaseFlows.runOrderCatchupScheduler().catch((err) =>
    console.error("Error en runOrderCatchupScheduler:", err)
  );
  postPurchaseFlows.runContestCatchupScheduler().catch((err) =>
    console.error("Error en runContestCatchupScheduler:", err)
  );
  postPurchaseFlows.runSeptiembreCatchupScheduler().catch((err) =>
    console.error("Error en runSeptiembreCatchupScheduler:", err)
  );
}, USAGE_SCHEDULER_INTERVAL_MS);
