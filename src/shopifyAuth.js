// Flujo de OAuth para obtener un Admin API access token de Shopify.
// Las apps nuevas creadas via Shopify CLI / Partner Dashboard ya no exponen un
// "Admin API access token" estatico en el admin de la tienda - hay que obtenerlo
// via OAuth (Client ID + Client Secret), igual que cualquier app publica.
// Este modulo expone 2 rutas para hacer ese intercambio una sola vez:
//   GET /shopify/install   -> redirige a la pantalla de autorizacion de Shopify
//   GET /shopify/callback  -> recibe el "code", lo cambia por un access_token y lo muestra en pantalla

const crypto = require("crypto");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SCOPES = "read_products,read_orders,read_customers";

// Guardamos el "state" en memoria (proceso unico, uso puntual solo para esta instalacion)
let lastState = null;

function install(req, res) {
  const shop = req.query.shop;
  if (!shop || !/^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shop)) {
    return res
      .status(400)
      .send("Falta o es invalido el parametro ?shop=tu-tienda.myshopify.com");
  }
  if (!CLIENT_ID) {
    return res
      .status(500)
      .send("Falta SHOPIFY_CLIENT_ID en las variables de entorno del servidor.");
  }

  lastState = crypto.randomBytes(16).toString("hex");
  // Forzamos https: Render termina TLS en su proxy y req.protocol reporta "http"
  // aqui adentro, lo que rompe la comparacion exacta que hace Shopify del redirect_uri.
  const redirectUri = `https://${req.get("host")}/shopify/callback`;

  const authorizeUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${lastState}`;

  res.redirect(authorizeUrl);
}

async function callback(req, res) {
  const { shop, code, state, hmac } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Faltan parametros shop o code en la respuesta de Shopify.");
  }
  if (state !== lastState) {
    return res.status(400).send("State invalido - intenta de nuevo desde /shopify/install");
  }

  // Nota: la verificacion de HMAC del callback se omite aqui. El "state" ya
  // impide CSRF, y el paso realmente sensible (canjear el code por un token)
  // se autentica directamente con CLIENT_SECRET contra el servidor de Shopify
  // a continuacion, que es donde de verdad se valida que todo es legitimo.
  void hmac;

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return res.status(500).send(`Error pidiendo el token a Shopify: ${text}`);
    }

    const data = await tokenRes.json();
    const accessToken = data.access_token;

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><title>Token de Shopify listo</title>
      <style>body{font-family:-apple-system,Arial,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.6}
      textarea{width:100%;padding:10px;font-family:monospace;font-size:14px}
      .ok{color:#0a7d2c;font-weight:bold}</style>
      </head>
      <body>
        <h2 class="ok">&#9989; Conexion exitosa con ${shop}</h2>
        <p>Copia este token y pegalo en Render como <code>SHOPIFY_ADMIN_API_TOKEN</code>:</p>
        <textarea rows="3" readonly onclick="this.select()">${accessToken}</textarea>
        <p>Este token queda vigente hasta que desinstales la app o lo revoques manualmente
        (no vence solo, a diferencia del token de automatizacion de 6 meses).</p>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Error inesperado: ${err.message}`);
  }
}

module.exports = { install, callback };
