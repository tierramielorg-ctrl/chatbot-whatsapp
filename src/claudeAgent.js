const Anthropic = require("@anthropic-ai/sdk");
const shopify = require("./shopify");
const { getSession, appendMessage } = require("./session");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const SYSTEM_PROMPT = `Eres el asistente de atencion al cliente de Tierra Miel, una tienda chilena
(tierramiel.org) que vende por Shopify. Respondes por WhatsApp, en espanol de Chile, de forma
calida, cercana y breve (los mensajes de WhatsApp deben ser cortos, sin bloques largos de texto).

Tus objetivos:
1. Atencion al cliente: responder dudas generales (envios, horarios, medios de pago, cambios/devoluciones)
   de forma honesta. Si no sabes algo con certeza y no tienes una herramienta para verificarlo, dilo
   claramente y ofrece derivar a una persona del equipo en vez de inventar una respuesta.
2. Ventas y recomendacion de productos: usa la herramienta search_products para buscar en el catalogo
   real antes de recomendar o de dar un precio. Nunca inventes precios, stock ni nombres de productos.
3. Seguimiento de pedidos: usa get_order_status si el cliente da un numero de pedido (ej "#1032" o "1032").
   Usa get_customer_orders si el cliente no tiene el numero pero te da su email o si prefieres buscar por
   su telefono (el numero de WhatsApp del cliente ya esta disponible como su telefono de contacto).

Reglas importantes:
- Todos los precios estan en pesos chilenos (CLP).
- Nunca reveles datos de otro cliente distinto al que esta escribiendo.
- Si una herramienta falla o no encuentra resultados, dilo con naturalidad y ofrece alternativas
  (buscar con otro termino, confirmar el numero de pedido, o hablar con una persona del equipo).
- No uses markdown pesado (nada de tablas); WhatsApp solo soporta *negrita*, _cursiva_ y listas simples con guiones.
- Cierra ofreciendo un siguiente paso util cuando tenga sentido, sin sonar a vendedor insistente.`;

const tools = [
  {
    name: "search_products",
    description:
      "Busca productos en el catalogo de Shopify de Tierra Miel por texto libre (nombre, tipo, ingrediente, etc). Devuelve titulo, precio, stock y link.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Termino de busqueda, ej: 'miel de ulmo' o 'polen'",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_order_status",
    description:
      "Consulta el estado de un pedido especifico de Shopify dado su numero (ej '1032' o '#1032'). Devuelve estado de pago, de despacho y datos de tracking si existen.",
    input_schema: {
      type: "object",
      properties: {
        order_number: {
          type: "string",
          description: "Numero de pedido, con o sin '#'",
        },
      },
      required: ["order_number"],
    },
  },
  {
    name: "get_customer_orders",
    description:
      "Lista los pedidos recientes de un cliente en Shopify buscando por email o telefono, cuando el cliente no sabe su numero de pedido.",
    input_schema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Email o telefono del cliente",
        },
      },
      required: ["identifier"],
    },
  },
];

async function runTool(name, input, whatsappPhone) {
  try {
    switch (name) {
      case "search_products": {
        const results = await shopify.searchProducts(input.query);
        return results.length
          ? results
          : { message: "No se encontraron productos para esa busqueda." };
      }
      case "get_order_status": {
        const order = await shopify.getOrderStatus(input.order_number);
        return order || { message: "No se encontro un pedido con ese numero." };
      }
      case "get_customer_orders": {
        const identifier = input.identifier || whatsappPhone;
        const orders = await shopify.getCustomerOrders(identifier);
        return orders.length
          ? orders
          : { message: "No se encontraron pedidos para ese cliente." };
      }
      default:
        return { error: `Herramienta desconocida: ${name}` };
    }
  } catch (err) {
    console.error(`Error ejecutando tool ${name}:`, err);
    return { error: `Error consultando Shopify: ${err.message}` };
  }
}

/**
 * Procesa un mensaje entrante de un cliente y devuelve el texto de respuesta.
 * Mantiene el historial de conversacion por numero de telefono.
 */
async function handleMessage(phone, userText) {
  appendMessage(phone, "user", userText);
  const session = getSession(phone);

  let messages = [...session.messages];
  let finalText = null;
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");

    if (toolUses.length === 0) {
      finalText = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    // Hay tool calls: ejecutarlas y devolver los resultados al modelo
    messages.push({ role: "assistant", content: response.content });

    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        const result = await runTool(tu.name, tu.input, phone);
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        };
      })
    );

    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) {
    finalText =
      "Disculpa, tuve un problema procesando tu consulta. ¿Puedes intentar de nuevo o reformularla?";
  }

  // Persistimos solo el historial final (incluye los turnos intermedios de tools)
  session.messages = messages.slice(-20);
  session.lastActive = Date.now();

  return finalText;
}

module.exports = { handleMessage };
