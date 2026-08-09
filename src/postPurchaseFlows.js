// Orquesta los 2 flujos automaticos post-compra:
// 1) Personalizacion: se dispara cuando se crea/paga un pedido con productos que
//    necesitan preguntas (ver knowledge/personalization.js).
// 2) Modo de uso: se dispara N dias habiles despues de que el pedido se marca
//    como preparado/despachado, segun la region de envio.

const shopify = require("./shopify");
const whatsapp = require("./whatsapp");
const session = require("./session");
const { productNeedsPersonalization } = require("./knowledge/personalization");

const TEMPLATE_PERSONALIZATION = process.env.WHATSAPP_TEMPLATE_PERSONALIZATION || "tierra_miel_personalizacion";
const TEMPLATE_USAGE = process.env.WHATSAPP_TEMPLATE_USAGE || "tierra_miel_modo_de_uso";
const TEMPLATE_TRACKING = process.env.WHATSAPP_TEMPLATE_TRACKING || "tierra_miel_seguimiento";
const TEMPLATE_WELCOME = process.env.WHATSAPP_TEMPLATE_WELCOME || "tierra_miel_bienvenida";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "es";

/** Normaliza un telefono de Shopify (+56 9 1234 5678, etc) al formato que pide WhatsApp (sin +, sin espacios). */
function normalizePhone(raw) {
  if (!raw) return null;
  return raw.replace(/[^\d]/g, "");
}

/** Suma N dias habiles (lunes a viernes) a una fecha. Aproximado: no descuenta feriados. */
function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay(); // 0 = domingo, 6 = sabado
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

function businessDaysForProvince(province) {
  const p = (province || "").toLowerCase();
  if (p.includes("arica") || p.includes("parinacota") || p.includes("tarapac")) return 8;
  if (p.includes("aysén") || p.includes("aysen") || p.includes("magallanes")) return 10;
  return 5;
}

/**
 * Manda un mensaje de bienvenida calido para pedidos que no necesitan preguntas
 * de personalizacion (ej: miel, polen, jabones) - asi el cliente igual siente
 * la cercania de un WhatsApp real, no solo el email automatico de Shopify.
 */
async function sendWelcomeMessage(order) {
  const phone = normalizePhone(order.phone);
  if (!phone) {
    await shopify.addOrderTags(order.id, ["tm-sin-telefono"]);
    return;
  }
  const firstName = (order.customerName || "").split(" ")[0] || "";
  const sent = await whatsapp.sendTemplateMessage(phone, TEMPLATE_WELCOME, TEMPLATE_LANG, [firstName, order.name]);
  if (!sent) {
    console.error(`Pedido ${order.name}: fallo el envio de la plantilla de bienvenida.`);
    return;
  }
  await shopify.addOrderTags(order.id, ["tm-bienvenida-enviada"]);
  console.log(`Pedido ${order.name}: plantilla de bienvenida enviada a ${phone}.`);
}

/**
 * Se llama cuando llega el webhook orders/create (o orders/paid) de Shopify.
 * Si el pedido tiene productos que necesitan personalizacion, manda la plantilla
 * de apertura y deja la conversacion de ese telefono en modo "personalization".
 */
async function handleOrderCreated(orderPayload) {
  const orderName = (orderPayload.name || "").replace("#", "");
  const order = await shopify.getOrderForAutomation(orderName);
  if (!order) {
    console.warn(`postPurchaseFlows: no se encontro la orden ${orderName} para procesar.`);
    return;
  }

  const needsFlow = order.lineItems.some((li) => productNeedsPersonalization(li.title));
  if (!needsFlow) {
    console.log(`Pedido ${order.name}: ningun producto requiere personalizacion, se manda bienvenida.`);
    await sendWelcomeMessage(order);
    return;
  }

  const phone = normalizePhone(order.phone);
  if (!phone) {
    console.warn(`Pedido ${order.name}: no tiene telefono, no se puede iniciar personalizacion por WhatsApp.`);
    await shopify.addOrderTags(order.id, ["tm-sin-telefono"]);
    return;
  }

  const firstName = (order.customerName || "").split(" ")[0] || "";
  const sent = await whatsapp.sendTemplateMessage(phone, TEMPLATE_PERSONALIZATION, TEMPLATE_LANG, [firstName]);
  if (!sent) {
    console.error(`Pedido ${order.name}: fallo el envio de la plantilla de personalizacion.`);
    return;
  }

  await shopify.addOrderTags(order.id, ["tm-personalizacion-enviada"]);
  await shopify.setOrderMetafield(order.id, "personalization_phone", phone);
  session.setSessionMode(phone, "personalization", order.id, order.name);
  console.log(`Pedido ${order.name}: plantilla de personalizacion enviada a ${phone}.`);
}

// Tags que indican que este pedido ya esta en algun punto del flujo de modo de
// uso (para no re-programarlo cada vez que el pedido se actualiza por otra razon).
const USAGE_FLOW_TAGS = ["tm-usage-pending", "tm-usage-enviado", "tm-modo-uso-completo"];

/**
 * Manda de inmediato la plantilla de seguimiento (numero + link de tracking)
 * apenas el pedido se marca como despachado. Se controla con el tag
 * "tm-tracking-enviado" para que no se mande mas de una vez.
 */
async function sendTrackingNotification(order) {
  const phone = normalizePhone(order.phone);
  if (!phone) {
    await shopify.addOrderTags(order.id, ["tm-sin-telefono"]);
    return;
  }
  if (!order.tracking) {
    console.log(`Pedido ${order.name}: aun no hay numero de tracking, se reintentara en la proxima actualizacion.`);
    return;
  }

  const firstName = (order.customerName || "").split(" ")[0] || "";
  const trackingLink = order.tracking.url || order.tracking.number || "";
  const sent = await whatsapp.sendTemplateMessage(phone, TEMPLATE_TRACKING, TEMPLATE_LANG, [
    firstName,
    order.name,
    trackingLink,
  ]);
  if (!sent) {
    console.error(`Pedido ${order.name}: fallo el envio de la plantilla de seguimiento.`);
    return;
  }
  await shopify.addOrderTags(order.id, ["tm-tracking-enviado"]);
  console.log(`Pedido ${order.name}: plantilla de seguimiento enviada a ${phone} (tracking: ${trackingLink}).`);
}

/**
 * Se llama cuando llega el webhook orders/updated de Shopify (usamos este en vez
 * de fulfillments/create porque ese topico necesita un scope mas granular que no
 * pedimos). Cuando detecta que el pedido paso a "fulfilled":
 * 1) manda de inmediato el aviso de seguimiento/tracking (si no se mando antes), y
 * 2) si todavia no estaba en el flujo de modo de uso, programa ese mensaje para
 *    mas adelante segun la region.
 */
async function handleOrderUpdated(orderPayload) {
  if (orderPayload.fulfillment_status !== "fulfilled") return;

  const existingTags = (orderPayload.tags || "").split(",").map((t) => t.trim());
  const orderName = orderPayload.name ? orderPayload.name.replace("#", "") : null;
  if (!orderName) return;

  const alreadyInUsageFlow = USAGE_FLOW_TAGS.some((t) => existingTags.includes(t));
  const alreadySentTracking = existingTags.includes("tm-tracking-enviado");
  if (alreadyInUsageFlow && alreadySentTracking) return; // nada nuevo que hacer

  const order = await shopify.getOrderForAutomation(orderName);
  if (!order) return;

  if (!alreadySentTracking) {
    await sendTrackingNotification(order);
  }

  if (!alreadyInUsageFlow) {
    const days = businessDaysForProvince(order.province);
    const scheduledAt = addBusinessDays(new Date(), days);
    await shopify.setOrderMetafield(order.id, "usage_scheduled_at", scheduledAt.toISOString());
    await shopify.addOrderTags(order.id, ["tm-usage-pending"]);
    console.log(`Pedido ${order.name}: mensaje de modo de uso programado para ${scheduledAt.toISOString()} (${days} dias habiles, region: ${order.province}).`);
  }
}

/**
 * Revision periodica (llamada por un setInterval en server.js). Busca pedidos
 * marcados "tm-usage-pending" cuya fecha programada ya paso, y les manda la
 * plantilla de apertura del flujo de modo de uso.
 */
async function runUsageScheduler() {
  let orders;
  try {
    orders = await shopify.findOrdersByTag("tm-usage-pending", 25);
  } catch (err) {
    console.error("runUsageScheduler: error buscando pedidos pendientes:", err);
    return;
  }

  for (const { id, name } of orders) {
    try {
      const scheduledAtRaw = await shopify.getOrderMetafield(id, "usage_scheduled_at");
      if (!scheduledAtRaw) continue;
      if (new Date(scheduledAtRaw) > new Date()) continue; // todavia no toca

      const order = await shopify.getOrderForAutomation(name.replace("#", ""));
      if (!order) continue;
      const phone = normalizePhone(order.phone);
      if (!phone) {
        await shopify.removeOrderTags(id, ["tm-usage-pending"]);
        await shopify.addOrderTags(id, ["tm-sin-telefono"]);
        continue;
      }

      const firstName = (order.customerName || "").split(" ")[0] || "";
      const sent = await whatsapp.sendTemplateMessage(phone, TEMPLATE_USAGE, TEMPLATE_LANG, [firstName, order.name]);
      if (!sent) continue;

      await shopify.removeOrderTags(id, ["tm-usage-pending"]);
      await shopify.addOrderTags(id, ["tm-usage-enviado"]);
      session.setSessionMode(phone, "usage", id, order.name);
      console.log(`Pedido ${order.name}: plantilla de modo de uso enviada a ${phone}.`);
    } catch (err) {
      console.error(`runUsageScheduler: error procesando pedido ${name}:`, err);
    }
  }
}

module.exports = {
  handleOrderCreated,
  handleOrderUpdated,
  runUsageScheduler,
  businessDaysForProvince,
  normalizePhone,
};
