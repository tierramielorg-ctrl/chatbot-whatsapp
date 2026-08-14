// Notificaciones por email via Resend (https://resend.com): tanto internas (avisarle
// a Tierra Miel cada vez que un cliente responde el flujo de personalizacion) como
// hacia clientes (ej. confirmacion de ticket del sorteo).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "tierramiel.org@gmail.com";
// Dominio "from" de prueba de Resend, funciona sin verificar dominio propio.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Tierra Miel Bot <onboarding@resend.dev>";
// OJO: "onboarding@resend.dev" es el dominio de PRUEBA de Resend - solo entrega al
// correo dueno de la cuenta Resend, no a clientes reales. Para mandarle email a
// clientes de verdad hay que verificar un dominio propio en resend.com/domains
// (ej. mail.tierramiel.org) y configurar CUSTOMER_FROM_EMAIL con ese dominio.
const CUSTOMER_FROM_EMAIL = process.env.CUSTOMER_FROM_EMAIL || FROM_EMAIL;

async function sendInternalNotification(subject, bodyText) {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY no configurado - se omite la notificacion por email:", subject);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        subject,
        text: bodyText,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Error enviando notificacion por email:", res.status, text);
    }
  } catch (err) {
    console.error("Error inesperado enviando notificacion por email:", err);
  }
}

/** Manda un email a un CLIENTE (no a Tierra Miel). Requiere dominio verificado, ver nota arriba. */
async function sendCustomerEmail(toEmail, subject, bodyText) {
  if (!RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY no configurado - se omite el email a ${toEmail}: ${subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: CUSTOMER_FROM_EMAIL,
        to: [toEmail],
        subject,
        text: bodyText,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Error enviando email a ${toEmail}:`, res.status, text);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Error inesperado enviando email a ${toEmail}:`, err);
    return false;
  }
}

module.exports = { sendInternalNotification, sendCustomerEmail };
