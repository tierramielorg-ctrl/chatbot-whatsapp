// Orquesta los 2 flujos automaticos post-compra:
// 1) Personalizacion: se dispara cuando se crea/paga un pedido con productos que
//    necesitan preguntas (ver knowledge/personalization.js).
// 2) Modo de uso: se dispara N dias habiles despues de que el pedido se marca
//    como preparado/despachado, segun la region de envio.

const shopify = require("./shopify");
const whatsapp = require("./whatsapp");
const session = require("./session");
const conversationLog = require("./conversationLog");
const notify = require("./notify");
const { productNeedsPersonalization } = require("./knowledge/personalization");

const TEMPLATE_PERSONALIZATION = process.env.WHATSAPP_TEMPLATE_PERSONALIZATION || "tierra_miel_personalizacion";
const TEMPLATE_USAGE = process.env.WHATSAPP_TEMPLATE_USAGE || "tierra_miel_modo_de_uso";
const TEMPLATE_TRACKING = process.env.WHATSAPP_TEMPLATE_TRACKING || "tierra_miel_seguimiento";
const TEMPLATE_WELCOME = process.env.WHATSAPP_TEMPLATE_WELCOME || "tierra_miel_bienvenida";
const TEMPLATE_REVIEW = process.env.WHATSAPP_TEMPLATE_REVIEW || "tierra_miel_resena";
const TEMPLATE_SORTEO = process.env.WHATSAPP_TEMPLATE_SORTEO || "tierra_miel_sorteo_ticket";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "es";
const REVIEW_DELAY_DAYS = Number(process.env.REVIEW_DELAY_DAYS) || 7;
const DISCOUNT_CODE_REVIEW = process.env.DISCOUNT_CODE_REVIEW || "";
const REVIEW_LINK = process.env.REVIEW_LINK || "";

// ---- Sorteo "Una compra, tres premios" (bases en https://tierramiel.org/pages/sorteo) ----
// Compras validas del 13 al 27 de agosto de 2026. Sorteo en vivo el 28 de agosto, 20:00 hrs
// (Chile), por Instagram con random.org. El ticket extra por compartir historia + etiquetar
// a 3 amigos lo registra Tierra Miel a mano viendo Instagram (no es parte de esta automatizacion).
const CONTEST_START = new Date("2026-08-13T00:00:00-04:00");
const CONTEST_END = new Date("2026-08-27T23:59:59-04:00");

/** Normaliza un telefono de Shopify (+56 9 1234 5678, etc) al formato que pide WhatsApp (sin +, sin espacios). */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  // Pedidos antiguos a veces guardaron el telefono sin el codigo de pais (56).
  // Un celular chileno sin codigo de pais son 9 digitos y empieza con 9.
  if (digits.length === 9 && digits.startsWith("9")) {
    return `56${digits}`;
  }
  return digits;
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
  conversationLog.logMessage(phone, "out", `[Plantilla bienvenida] Pedido ${order.name} recibido.`, order.customerName);
  await shopify.appendOrderNote(
    order.id,
    `WhatsApp bot ${new Date().toLocaleString("es-CL")}: mensaje de bienvenida enviado a ${phone}.`
  ).catch((err) => console.error(`Pedido ${order.name}: error dejando nota de bienvenida:`, err));
  console.log(`Pedido ${order.name}: plantilla de bienvenida enviada a ${phone}.`);
}

function orderInContestWindow(createdAt) {
  if (!createdAt) return false;
  const d = new Date(createdAt);
  return d >= CONTEST_START && d <= CONTEST_END;
}

/**
 * Sorteo "Una compra, tres premios": si el pedido cae dentro de la ventana del
 * concurso, confirma el ticket de participacion por email (no necesita aprobacion,
 * sale de inmediato) y por WhatsApp (plantilla nueva, puede tardar en aprobarse en
 * Meta - mientras tanto el catchup scheduler reintenta solo). Usamos el numero de
 * pedido como numero de ticket: es unico automaticamente y facil de verificar contra
 * Shopify. Revisa los tags antes de mandar cada canal para no duplicar en reintentos.
 */
async function sendContestEntryNotification(order) {
  if (!orderInContestWindow(order.createdAt)) return;

  const firstName = (order.customerName || "").split(" ")[0] || "";
  const ticketId = order.name;
  const tags = order.tags || [];

  if (order.email && !tags.includes("tm-sorteo-email-enviado")) {
    const subject = "🎉 ¡Ya estás participando en el sorteo de Tierra Miel!";
    const body = `¡Hola ${firstName}!

Tu compra ${order.name} ya te dio un ticket de participación en el sorteo "Una compra, tres premios" de Tierra Miel 🍯

🎫 Tu número de ticket: ${ticketId}

Se sortean 3 premios entre 3 ganadores distintos:
- Kit Ritual de la Naturaleza
- Gift Card $25.000
- Pack Gourmet con Molinillo

📅 Sorteo en vivo: 28 de agosto, 20:00 hrs, por Instagram, con random.org.

¿Quieres el doble de chances? Sube la historia del concurso y etiqueta a 3 amigos - nosotros lo vemos y te sumamos el ticket extra automáticamente.

Gracias por comprar con Tierra Miel 💛`;
    const emailSent = await notify.sendCustomerEmail(order.email, subject, body);
    if (emailSent) {
      await shopify.addOrderTags(order.id, ["tm-sorteo-email-enviado"]).catch((err) =>
        console.error(`Pedido ${order.name}: error marcando tag de email del sorteo:`, err)
      );
      console.log(`Pedido ${order.name}: ticket de sorteo (${ticketId}) confirmado por email a ${order.email}.`);
    }
  }

  const phone = normalizePhone(order.phone);
  if (phone && !tags.includes("tm-sorteo-whatsapp-enviado")) {
    const sent = await whatsapp.sendTemplateMessage(phone, TEMPLATE_SORTEO, TEMPLATE_LANG, [firstName, ticketId]);
    if (sent) {
      await shopify.addOrderTags(order.id, ["tm-sorteo-whatsapp-enviado"]);
      conversationLog.logMessage(phone, "out", `[Plantilla sorteo] Ticket de participación: ${ticketId}.`, order.customerName);
      await shopify.appendOrderNote(
        order.id,
        `WhatsApp bot ${new Date().toLocaleString("es-CL")}: ticket de participación del sorteo (${ticketId}) confirmado por WhatsApp a ${phone}.`
      ).catch((err) => console.error(`Pedido ${order.name}: error dejando nota del sorteo:`, err));
      console.log(`Pedido ${order.name}: ticket de sorteo (${ticketId}) confirmado por WhatsApp a ${phone}.`);
    } else {
      console.log(`Pedido ${order.name}: la plantilla "${TEMPLATE_SORTEO}" aun no esta aprobada (o fallo el envio) - se reintenta sola en el proximo scheduler.`);
    }
  }
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

  await sendContestEntryNotification(order).catch((err) =>
    console.error(`Pedido ${order.name}: error en la notificacion del sorteo:`, err)
  );

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
  conversationLog.logMessage(phone, "out", `[Plantilla personalización] Pedido ${order.name}.`, order.customerName);
  await shopify.appendOrderNote(
    order.id,
    `WhatsApp bot ${new Date().toLocaleString("es-CL")}: mensaje de personalización (preguntas) enviado a ${phone}.`
  ).catch((err) => console.error(`Pedido ${order.name}: error dejando nota de personalizacion:`, err));
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
  conversationLog.logMessage(phone, "out", `[Plantilla seguimiento] Pedido ${order.name}: ${trackingLink}`, order.customerName);
  await shopify.appendOrderNote(
    order.id,
    `WhatsApp bot ${new Date().toLocaleString("es-CL")}: seguimiento enviado a ${phone} (${trackingLink}).`
  ).catch((err) => console.error(`Pedido ${order.name}: error dejando nota de seguimiento:`, err));
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
 * Manda la plantilla de resena + descuento. Se llama desde el scheduler de
 * resenas, "REVIEW_DELAY_DAYS" despues de mandado el mensaje de modo de uso.
 */
async function sendReviewNotification(order) {
  const phone = normalizePhone(order.phone);
  if (!phone) {
    await shopify.addOrderTags(order.id, ["tm-sin-telefono"]);
    return false;
  }
  const firstName = (order.customerName || "").split(" ")[0] || "";

  // Usamos la pagina del primer producto del pedido como link de resena (ahi vive
  // el widget de Vitals), en vez de un link generico a la tienda.
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN || "";
  const firstHandle = order.lineItems.find((li) => li.handle)?.handle;
  const productLink = firstHandle
    ? `https://${storeDomain.replace(".myshopify.com", "")}.com/products/${firstHandle}`
    : REVIEW_LINK || `https://${storeDomain.replace(".myshopify.com", "")}.com`;

  const sent = await whatsapp.sendTemplateMessage(phone, TEMPLATE_REVIEW, TEMPLATE_LANG, [
    firstName,
    order.name,
    productLink,
    DISCOUNT_CODE_REVIEW || "RESENA10",
  ]);
  if (!sent) {
    console.error(`Pedido ${order.name}: fallo el envio de la plantilla de resena.`);
    return false;
  }
  conversationLog.logMessage(phone, "out", `[Plantilla reseña] Pedido ${order.name}, código ${DISCOUNT_CODE_REVIEW || "RESENA10"}.`, order.customerName);
  await shopify.appendOrderNote(
    order.id,
    `WhatsApp bot ${new Date().toLocaleString("es-CL")}: mensaje de reseña + descuento enviado a ${phone} (código ${DISCOUNT_CODE_REVIEW || "RESENA10"}).`
  ).catch((err) => console.error(`Pedido ${order.name}: error dejando nota de resena:`, err));
  console.log(`Pedido ${order.name}: plantilla de resena enviada a ${phone}.`);
  return true;
}

/**
 * Revision periodica (llamada por un setInterval en server.js). Busca pedidos
 * marcados "tm-review-pending" cuya fecha programada ya paso, y les manda la
 * plantilla de resena + descuento.
 */
async function runReviewScheduler() {
  let orders;
  try {
    orders = await shopify.findOrdersByTag("tm-review-pending", 25);
  } catch (err) {
    console.error("runReviewScheduler: error buscando pedidos pendientes:", err);
    return;
  }

  for (const { id, name } of orders) {
    try {
      const scheduledAtRaw = await shopify.getOrderMetafield(id, "review_scheduled_at");
      if (!scheduledAtRaw) continue;
      if (new Date(scheduledAtRaw) > new Date()) continue; // todavia no toca

      const order = await shopify.getOrderForAutomation(name.replace("#", ""));
      if (!order) continue;

      const ok = await sendReviewNotification(order);
      if (!ok) continue;

      await shopify.removeOrderTags(id, ["tm-review-pending"]);
      await shopify.addOrderTags(id, ["tm-resena-enviada"]);
    } catch (err) {
      console.error(`runReviewScheduler: error procesando pedido ${name}:`, err);
    }
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
      conversationLog.logMessage(phone, "out", `[Plantilla modo de uso] Pedido ${order.name}.`, order.customerName);
      await shopify.appendOrderNote(
        id,
        `WhatsApp bot ${new Date().toLocaleString("es-CL")}: mensaje de modo de uso enviado a ${phone}.`
      ).catch((err) => console.error(`Pedido ${order.name}: error dejando nota de modo de uso:`, err));
      console.log(`Pedido ${order.name}: plantilla de modo de uso enviada a ${phone}.`);

      // Programamos el recordatorio de resena para mas adelante (dias corridos, no habiles).
      const reviewAt = new Date();
      reviewAt.setDate(reviewAt.getDate() + REVIEW_DELAY_DAYS);
      await shopify.setOrderMetafield(id, "review_scheduled_at", reviewAt.toISOString());
      await shopify.addOrderTags(id, ["tm-review-pending"]);
      console.log(`Pedido ${order.name}: recordatorio de resena programado para ${reviewAt.toISOString()}.`);
    } catch (err) {
      console.error(`runUsageScheduler: error procesando pedido ${name}:`, err);
    }
  }
}

/**
 * Red de seguridad (llamada periodicamente por server.js): revisa pedidos de las
 * ultimas 48h que se quedaron sin ninguna etiqueta "tm-" (el webhook no los
 * proceso, ej. por un reinicio del servidor en mal momento) y los reprocesa
 * como si el webhook orders/create acabara de llegar.
 */
async function runOrderCatchupScheduler() {
  let orders;
  try {
    orders = await shopify.findRecentOrdersMissingAutomation(48, 50);
  } catch (err) {
    console.error("runOrderCatchupScheduler: error buscando pedidos sin procesar:", err);
    return;
  }

  for (const { name } of orders) {
    try {
      console.log(`runOrderCatchupScheduler: reprocesando pedido ${name} (se quedo sin etiqueta tm-).`);
      await handleOrderCreated({ name });
    } catch (err) {
      console.error(`runOrderCatchupScheduler: error reprocesando pedido ${name}:`, err);
    }
  }
}

/**
 * Red de seguridad del sorteo (llamada periodicamente por server.js): reintenta la
 * confirmacion de ticket (WhatsApp y/o email) para pedidos dentro de la ventana del
 * concurso que todavia les falte algun canal - por ejemplo mientras Meta aprueba la
 * plantilla nueva. Se detiene sola despues del 27 de agosto.
 */
async function runContestCatchupScheduler() {
  if (new Date() > CONTEST_END) return;

  for (const tag of ["tm-sorteo-whatsapp-enviado", "tm-sorteo-email-enviado"]) {
    let orders;
    try {
      orders = await shopify.findOrdersCreatedBetweenMissingTag(
        CONTEST_START.toISOString(),
        CONTEST_END.toISOString(),
        tag,
        50
      );
    } catch (err) {
      console.error(`runContestCatchupScheduler: error buscando pedidos sin "${tag}":`, err);
      continue;
    }
    for (const { name } of orders) {
      try {
        const order = await shopify.getOrderForAutomation(name.replace("#", ""));
        if (!order) continue;
        await sendContestEntryNotification(order);
      } catch (err) {
        console.error(`runContestCatchupScheduler: error reprocesando pedido ${name}:`, err);
      }
    }
  }
}

module.exports = {
  handleOrderCreated,
  handleOrderUpdated,
  runUsageScheduler,
  runReviewScheduler,
  runOrderCatchupScheduler,
  runContestCatchupScheduler,
  businessDaysForProvince,
  normalizePhone,
};
