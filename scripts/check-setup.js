// Valida las credenciales de .env haciendo una llamada real y minima a cada
// servicio, SIN imprimir nunca los valores secretos — solo dice si cada uno
// funciona o no, y por que. Correr con: npm run verify

require("dotenv").config();

const CHECK = { ok: "✅", fail: "❌", warn: "⚠️ " };
let hasFailure = false;

function fail(label, msg) {
  hasFailure = true;
  console.log(`${CHECK.fail} ${label}: ${msg}`);
}
function ok(label, msg) {
  console.log(`${CHECK.ok} ${label}: ${msg}`);
}
function warn(label, msg) {
  console.log(`${CHECK.warn} ${label}: ${msg}`);
}

function looksLikePlaceholder(value) {
  if (!value) return true;
  return /xxxx|\.\.\.|tu-tienda|elige-una-clave|sk-ant-xxxxx/i.test(value);
}

async function checkShopify() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || "2024-10";

  if (looksLikePlaceholder(domain) || looksLikePlaceholder(token)) {
    return fail(
      "Shopify",
      "SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_API_TOKEN faltan o siguen con el valor de ejemplo."
    );
  }
  if (!token.startsWith("shpat_")) {
    return fail(
      "Shopify",
      `SHOPIFY_ADMIN_API_TOKEN deberia empezar con 'shpat_' (Admin API access token de una Custom App). Lo que hay ahora no tiene ese formato — revisa la pestana 'API credentials' de tu Custom App, campo 'Admin API access token' (no 'API key'/'API secret key').`
    );
  }
  try {
    const res = await fetch(`https://${domain}/admin/api/${version}/shop.json`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    if (res.status === 401 || res.status === 403) {
      return fail("Shopify", `token rechazado (HTTP ${res.status}). Revisa que sea el Admin API access token correcto y que la app tenga los scopes read_products, read_orders, read_customers.`);
    }
    if (!res.ok) {
      return fail("Shopify", `respuesta inesperada HTTP ${res.status}. Revisa SHOPIFY_STORE_DOMAIN (debe terminar en .myshopify.com).`);
    }
    const data = await res.json();
    ok("Shopify", `conectado a la tienda "${data.shop.name}" (${data.shop.myshopify_domain}).`);
  } catch (err) {
    fail("Shopify", `no se pudo conectar: ${err.message}`);
  }
}

async function checkWhatsApp() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || "v20.0";

  if (looksLikePlaceholder(token) || looksLikePlaceholder(phoneId)) {
    return fail(
      "WhatsApp",
      "WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID faltan o siguen con el valor de ejemplo. El Phone Number ID esta en Meta > WhatsApp > API Setup (NO es el Business Account ID)."
    );
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${phoneId}?fields=verified_name,display_phone_number`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (!res.ok) {
      return fail(
        "WhatsApp",
        `rechazado (HTTP ${res.status}): ${data.error?.message || "sin detalle"}. Revisa que WHATSAPP_PHONE_NUMBER_ID sea el 'Phone number ID' (no el Business Account ID) y que el token no haya expirado.`
      );
    }
    ok("WhatsApp", `conectado al numero "${data.display_phone_number}" (${data.verified_name}).`);
  } catch (err) {
    fail("WhatsApp", `no se pudo conectar: ${err.message}`);
  }

  if (looksLikePlaceholder(process.env.WHATSAPP_APP_SECRET)) {
    warn("WhatsApp App Secret", "no configurado — la firma del webhook no se va a verificar (funciona, pero es menos seguro). Ponlo en Settings > Basic de tu app de Meta.");
  }
  if (looksLikePlaceholder(process.env.WHATSAPP_VERIFY_TOKEN)) {
    warn("WhatsApp Verify Token", "sigue con el valor de ejemplo. Invéntate un string largo propio y usa el mismo en el panel de Meta al configurar el webhook.");
  }
}

async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (looksLikePlaceholder(key) || !key.startsWith("sk-ant-")) {
    return fail(
      "Anthropic",
      "ANTHROPIC_API_KEY falta, esta truncada o no tiene el formato 'sk-ant-...'. Copia la key completa desde console.anthropic.com > Settings > API Keys (se muestra una sola vez al crearla)."
    );
  }
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: key });
    await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hola" }],
    });
    ok("Anthropic", "API key valida, se pudo llamar al modelo.");
  } catch (err) {
    fail("Anthropic", `la key fue rechazada: ${err.message}`);
  }
}

(async () => {
  console.log("Verificando credenciales en .env...\n");
  await checkShopify();
  await checkWhatsApp();
  await checkAnthropic();
  console.log();
  if (hasFailure) {
    console.log("Hay credenciales por corregir antes de hacer deploy. Revisa los ❌ de arriba.");
    process.exit(1);
  } else {
    console.log("Todo listo ✅ — puedes hacer deploy.");
  }
})();
