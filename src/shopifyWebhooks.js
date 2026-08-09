// Recibe los webhooks de Shopify (pedido creado, pedido despachado) y dispara
// los flujos automaticos correspondientes.

const crypto = require("crypto");
const postPurchaseFlows = require("./postPurchaseFlows");

const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!CLIENT_SECRET || !hmacHeader) return false;
  const computed = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

function withVerification(handler) {
  return async (req, res) => {
    const hmac = req.get("X-Shopify-Hmac-Sha256");
    if (!verifyShopifyWebhook(req.rawBody, hmac)) {
      console.warn("Webhook de Shopify con firma invalida, se descarta.");
      return res.sendStatus(401);
    }
    // Responder rapido para que Shopify no reintente; procesar despues.
    res.sendStatus(200);
    try {
      await handler(req.body);
    } catch (err) {
      console.error("Error procesando webhook de Shopify:", err);
    }
  };
}

const ordersCreate = withVerification(postPurchaseFlows.handleOrderCreated);
const fulfillmentsCreate = withVerification(postPurchaseFlows.handleFulfillmentCreated);

module.exports = { ordersCreate, fulfillmentsCreate };
