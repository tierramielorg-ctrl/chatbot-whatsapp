// Libreria de "modo de uso" por producto, para el mensaje que se manda cuando
// el pedido ya deberia haber llegado. Cada entrada tiene palabras clave para
// hacer match contra el titulo del producto en la orden de Shopify.

const USAGE_LIBRARY = [
  { keywords: ["roll-on rinitis", "roll on rinitis"], name: "Roll-On Rinitis",
    usage: "Aplica en pecho, cuello, sienes o plantas de los pies, cuantas veces lo necesites durante el día." },
  { keywords: ["ungüento respiratorio", "unguento respiratorio"], name: "Ungüento Respiratorio",
    usage: "Aplica en pecho y espalda antes de dormir." },
  { keywords: ["defensas", "sistema inmune"], name: "Roll-On Defensas / Sistema Inmune",
    usage: "Aplica en pecho, espalda y plantas de los pies como rutina preventiva diaria." },
  { keywords: ["roll-on digestivo", "roll on digestivo"], name: "Roll-On Digestivo",
    usage: "Masajea sobre el abdomen con movimiento circular." },
  { keywords: ["ungüento digestivo", "unguento digestivo"], name: "Ungüento Digestivo",
    usage: "Aplica sobre el abdomen cuando sientas cólico, dolor o inflamación." },
  { keywords: ["quema grasa", "activación", "activacion"], name: "Crema Quema Grasa / Activación",
    usage: "Aplica y masajea en abdomen, piernas o glúteos." },
  { keywords: ["calma bruxismo", "roll-on bruxismo"], name: "Roll-On Calma Bruxismo",
    usage: "Aplica en mandíbula y cuello apenas sientas tensión, durante el día." },
  { keywords: ["home spray", "spray bruxismo"], name: "Home Spray Calma Bruxismo",
    usage: "Pulveriza sobre la almohada antes de dormir. Nunca directo sobre la piel." },
  { keywords: ["gotario antifúngico", "gotario antifungico"], name: "Gotario Antifúngico",
    usage: "Aplica directo sobre la zona afectada del pie." },
  { keywords: ["ungüento antifúngico", "unguento antifungico"], name: "Ungüento Antifúngico",
    usage: "Aplica en la piel del pie, especialmente entre los dedos, después de lavar y secar bien." },
  { keywords: ["hemorroidal"], name: "Ungüento Hemorroidal",
    usage: "Aplica en la zona con un toque suave, según necesidad, hasta 4 veces al día." },
  { keywords: ["menstrual"], name: "Ungüento Menstrual",
    usage: "Aplica en abdomen y zona lumbar según necesidad." },
  { keywords: ["roll-on energía", "roll on energia"], name: "Roll-On Energía",
    usage: "Aplica en muñecas, cuello o plantas de los pies cuando necesites un impulso." },
  { keywords: ["equilibrio emocional"], name: "Roll-On Equilibrio Emocional Kids",
    usage: "Aplica en muñecas, plantas de los pies o detrás de las orejas, 2 a 4 veces al día." },
  { keywords: ["bienestar emocional", "ansiedad", "estrés", "estres"], name: "Roll-On Bienestar Emocional",
    usage: "Aplica en muñecas, plantas de los pies o detrás de las orejas, cuando lo necesites." },
  { keywords: ["intensivo", "ciática", "ciatica", "artritis", "artrosis", "dolor muscular"], name: "Ungüento Dolor Muscular",
    usage: "Masajea la zona con dolor 2 a 3 veces al día, o más seguido si lo necesitas." },
  { keywords: ["piernas cansadas", "várices", "varices", "circulación activa", "circulacion activa", "calambres"], name: "Crema Piernas",
    usage: "Aplica de abajo hacia arriba con masaje suave, mañana y noche." },
  { keywords: ["pestañas", "pestanas", "cejas"], name: "Fortalecedor de Pestañas y Cejas",
    usage: "Aplica una capa fina sobre pestañas y cejas limpias, antes de dormir." },
  { keywords: ["dermatitis", "piel atópica", "piel atopica", "psoriasis"], name: "Crema (Dermatitis / Piel Atópica / Psoriasis)",
    usage: "Aplica en todo el cuerpo, mañana y noche, sobre piel limpia. Úsala todos los días para prevenir." },
  { keywords: ["ungüento dermatitis", "ungüento psoriasis"], name: "Ungüento (Dermatitis / Piel Atópica / Psoriasis)",
    usage: "Aplica solo en la zona más afectada, 2 a 3 veces al día." },
  { keywords: ["tónico reparador rosácea", "tonico reparador rosacea"], name: "Tónico Reparador Rosácea",
    usage: "3 a 5 pulverizaciones sobre el rostro limpio, mañana y noche." },
  { keywords: ["crema reparadora rosácea", "crema reparadora rosacea"], name: "Crema Reparadora Rosácea",
    usage: "Aplica después del tónico, sellando la hidratación." },
  { keywords: ["capilar", "anticaída", "anticaida", "fortalecimiento", "caspa"], name: "Tónico Capilar",
    usage: "Pulveriza sobre el cuero cabelludo, masajea con la yema de los dedos. No enjuagar. Uso diario." },
  { keywords: ["manos de miel", "sabañones", "sabanones"], name: "Manos de Miel",
    usage: "Aplica después de lavar las manos, cuantas veces sea necesario." },
  { keywords: ["desodorante"], name: "Desodorante Natural",
    usage: "Aplica sobre axilas limpias y secas." },
  { keywords: ["super blend"], name: "Super Blend",
    usage: "1 cucharadita al día, directo, con yogurt, o en el desayuno." },
  { keywords: ["polen", "pan de abeja"], name: "Polen / Pan de Abeja",
    usage: "Consumir según se indique en tu producto — en ayunas, con yogurt o directo." },
  { keywords: ["sal de mar", "pack gourmet"], name: "Sal de Mar / Pack Gourmet",
    usage: "Usa al gusto en tus preparaciones — reemplaza tu sal habitual." },
  { keywords: ["jabón", "jabon"], name: "Jabones Tierra y Miel",
    usage: "Humedece, frota suavemente hasta generar espuma, enjuaga con abundante agua." },
  { keywords: ["kit invierno", "kit niños invierno", "kit ninos invierno"], name: "Kit Niños Invierno",
    usage: "Roll-On Defensas en la mañana antes del colegio; Ungüento Respiratorio en la noche antes de dormir." },
  { keywords: ["miel"], name: "Miel",
    usage: "Consúmela directa, con yogurt, o como reemplazo del azúcar en tus preparaciones." },
];

function findUsageEntry(title) {
  const t = (title || "").toLowerCase();
  return USAGE_LIBRARY.find((entry) => entry.keywords.some((kw) => t.includes(kw)));
}

/**
 * A partir de una lista de line items de una orden de Shopify (con {title, handle}),
 * arma los bloques de "modo de uso" correspondientes, evitando duplicados.
 */
function buildUsageBlocks(lineItems, storeDomain) {
  const seen = new Set();
  const blocks = [];
  for (const item of lineItems) {
    const entry = findUsageEntry(item.title);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const link = item.handle
      ? `https://${(storeDomain || "").replace(".myshopify.com", "")}.com/products/${item.handle}`
      : null;
    blocks.push({ name: entry.name, usage: entry.usage, link });
  }
  return blocks;
}

module.exports = { USAGE_LIBRARY, findUsageEntry, buildUsageBlocks };
