// Notificaciones internas por email via Resend (https://resend.com), para avisarle
// a Tierra Miel cada vez que un cliente responde el flujo de personalizacion.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "tierramiel.org@gmail.com";
// Dominio "from" de prueba de Resend, funciona sin verificar dominio propio.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Tierra Miel Bot <onboarding@resend.dev>";

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

module.exports = { sendInternalNotification };
