// Endpoint publico para la pagina "Seguimiento de tu pedido" en tierramiel.org.
// El cliente ingresa numero de pedido + email/telefono; solo devuelve datos si
// coinciden con el pedido (ver shopify.getOrderStatusPublic). Sin eso, cualquiera
// podria escribir numeros de pedido al azar y ver datos de otras personas.

const express = require("express");
const shopify = require("./shopify");

const router = express.Router();

// Origenes desde los que se puede llamar este endpoint (el tema de Shopify).
const ALLOWED_ORIGINS = new Set([
  "https://tierramiel.org",
  "https://www.tierramiel.org",
  // dominio *.myshopify.com, para probar en el theme preview antes de publicar
  process.env.SHOPIFY_STORE_DOMAIN ? `https://${process.env.SHOPIFY_STORE_DOMAIN}` : null,
].filter(Boolean));

router.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Rate limit muy simple en memoria: max 8 intentos cada 10 min por IP, para
// frenar a alguien probando numeros de pedido al voleo. Se resetea si el
// proceso se reinicia, que es aceptable para este uso.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function isRateLimited(ip) {
  const now = Date.now();
  const record = attempts.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + WINDOW_MS;
  }
  record.count += 1;
  attempts.set(ip, record);
  return record.count > MAX_ATTEMPTS;
}

router.post("/track-order", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({
      found: false,
      error: "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
    });
  }

  const { orderNumber, identifier } = req.body || {};
  if (!orderNumber || !identifier) {
    return res.status(400).json({
      found: false,
      error: "Falta el numero de pedido o el email/telefono.",
    });
  }

  try {
    const order = await shopify.getOrderStatusPublic(orderNumber, identifier);
    if (!order) {
      return res.status(200).json({
        found: false,
        error: "No encontramos un pedido con esos datos. Revisa el numero y el email/telefono usados en la compra.",
      });
    }

    const tracking = order.tracking
      ? {
          company: order.tracking.company || null,
          number: order.tracking.number || null,
          url: order.tracking.url || null,
        }
      : null;

    return res.status(200).json({
      found: true,
      name: order.name,
      createdAt: order.createdAt,
      fulfillmentStatus: order.fulfillmentStatus,
      city: order.city,
      tracking,
    });
  } catch (err) {
    console.error("Error en /api/track-order:", err);
    return res.status(500).json({
      found: false,
      error: "Tuvimos un problema buscando tu pedido. Intenta de nuevo en un momento.",
    });
  }
});

module.exports = router;
