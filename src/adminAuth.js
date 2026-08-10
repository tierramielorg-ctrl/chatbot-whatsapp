// Autenticacion HTTP Basic simple para el panel de admin. El navegador pide
// usuario/clave con su propio dialogo nativo, sin que tengamos que armar login.

const crypto = require("crypto");

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "tierramiel";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).send("ADMIN_PASSWORD no esta configurado en el servidor.");
  }

  const header = req.get("Authorization");
  if (header && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);
    if (safeEqual(user, ADMIN_USERNAME) && safeEqual(pass, ADMIN_PASSWORD)) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Tierra Miel Admin"');
  return res.status(401).send("Autenticacion requerida.");
}

module.exports = { requireAdminAuth };
