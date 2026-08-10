const Anthropic = require("@anthropic-ai/sdk");
const shopify = require("./shopify");
const whatsapp = require("./whatsapp");
const notify = require("./notify");
const conversationLog = require("./conversationLog");
const { getSession, appendMessage, setSessionMode } = require("./session");
const { PERSONALIZATION_GUIDE } = require("./knowledge/personalization");
const { buildUsageBlocks } = require("./knowledge/usageLibrary");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Recorta el historial de mensajes a maxLen, pero sin cortar nunca justo en medio
 * de un par tool_use/tool_result - eso dejaba un tool_result huerfano al inicio
 * del historial, lo que la API de Anthropic rechaza con un 400 (bug real que
 * rompio conversaciones en produccion). Escanea hacia adelante desde el punto de
 * corte naive hasta encontrar un mensaje "seguro" para empezar.
 */
function safeTrimMessages(messages, maxLen) {
  if (messages.length <= maxLen) return messages;
  let start = messages.length - maxLen;
  while (start < messages.length) {
    const msg = messages[start];
    const isToolResultOnly =
      Array.isArray(msg.content) && msg.content.every((b) => b.type === "tool_result");
    if (!isToolResultOnly) break;
    start++;
  }
  return messages.slice(start);
}
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const SEBASTIAN_WELCOME_AUDIO_URL = process.env.SEBASTIAN_WELCOME_AUDIO_URL || "";
const CAROLINA_CLOSING_AUDIO_URL = process.env.CAROLINA_CLOSING_AUDIO_URL || "";

// ---------------------------------------------------------------------------
// MODO NORMAL (atencion al cliente reactiva)
// ---------------------------------------------------------------------------

const NORMAL_SYSTEM_PROMPT = `Eres el asistente de atencion al cliente de Tierra Miel, una tienda chilena
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

const normalTools = [
  {
    name: "search_products",
    description:
      "Busca productos en el catalogo de Shopify de Tierra Miel por texto libre (nombre, tipo, ingrediente, etc). Devuelve titulo, precio, stock y link.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Termino de busqueda, ej: 'miel de ulmo' o 'polen'" } },
      required: ["query"],
    },
  },
  {
    name: "get_order_status",
    description:
      "Consulta el estado de un pedido especifico de Shopify dado su numero (ej '1032' o '#1032'). Devuelve estado de pago, de despacho y datos de tracking si existen.",
    input_schema: {
      type: "object",
      properties: { order_number: { type: "string", description: "Numero de pedido, con o sin '#'" } },
      required: ["order_number"],
    },
  },
  {
    name: "get_customer_orders",
    description:
      "Lista los pedidos recientes de un cliente en Shopify buscando por email o telefono, cuando el cliente no sabe su numero de pedido.",
    input_schema: {
      type: "object",
      properties: { identifier: { type: "string", description: "Email o telefono del cliente" } },
      required: ["identifier"],
    },
  },
];

async function runNormalTool(name, input, whatsappPhone) {
  switch (name) {
    case "search_products": {
      const results = await shopify.searchProducts(input.query);
      return results.length ? results : { message: "No se encontraron productos para esa busqueda." };
    }
    case "get_order_status": {
      const order = await shopify.getOrderStatus(input.order_number);
      return order || { message: "No se encontro un pedido con ese numero." };
    }
    case "get_customer_orders": {
      const identifier = input.identifier || whatsappPhone;
      const orders = await shopify.getCustomerOrders(identifier);
      return orders.length ? orders : { message: "No se encontraron pedidos para ese cliente." };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// MODO PERSONALIZACION (post-compra, antes de preparar el pedido)
// ---------------------------------------------------------------------------

function personalizationSystemPrompt(orderName) {
  return `Estas conduciendo el flujo de PERSONALIZACION post-compra de Tierra Miel para el
pedido ${orderName}, por WhatsApp, en espanol de Chile, tono calido y cercano.

${PERSONALIZATION_GUIDE}

INSTRUCCIONES DE ESTA CONVERSACION:
- Ya se le envio al cliente el mensaje de apertura explicando por que se necesitan estas
  preguntas. Este es el mensaje de respuesta del cliente a esa apertura.
- Si es tu primer turno en esta conversacion, primero usa la herramienta send_welcome_audio
  para mandar el audio de bienvenida de Sebastian antes de empezar con las preguntas
  (si la herramienta indica que no hay audio configurado, simplemente sigue sin el).
- Conduce la conversacion de preguntas siguiendo la guia de arriba segun los productos
  reales del pedido (usa get_order_line_items para saber que compro exactamente).
- Para CADA pregunta que tenga opciones fijas (que es casi todas segun la guia), usa la
  herramienta ask_multiple_choice en vez de escribir las opciones como texto plano — se
  muestran como botones tocables en WhatsApp, mucho mas rapido y agradable de responder
  que leer un parrafo largo. Pon la pregunta completa en "question" y las opciones cortas
  (ideal menos de 20 caracteres cada una) en "options". Solo usa texto libre para las
  pocas preguntas sin opciones fijas (raras en esta guia) o para comentarios breves.
- Ve de a 1 pregunta por turno (una herramienta ask_multiple_choice a la vez), no mandes
  un formulario largo de una vez.
- Una vez tengas todas las respuestas necesarias, usa log_personalization_notes con un
  resumen claro (edad, sintoma/zona, cuando, frecuencia, y la variante/formula recomendada
  segun la logica de la guia) y luego cierra la conversacion agradeciendo, en el mismo
  mensaje o el siguiente, confirmando que ya tienen todo lo necesario para preparar el pedido.
- No uses markdown pesado; WhatsApp solo soporta *negrita*, _cursiva_ y listas con guiones.`;
}

const askMultipleChoiceTool = {
  name: "ask_multiple_choice",
  description:
    "Manda una pregunta con opciones tocables (botones o lista) por WhatsApp, en vez de texto plano. Usar para cualquier pregunta con opciones fijas.",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Texto completo de la pregunta, ej '¿Qué edad tiene la persona que lo usará?'" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Opciones cortas (2-10), ej ['1-3 años','4-6 años','7-11 años']. Cada una idealmente menos de 20 caracteres.",
      },
    },
    required: ["question", "options"],
  },
};

const personalizationTools = [
  {
    name: "get_order_line_items",
    description: "Devuelve los productos comprados en este pedido, para saber cuales necesitan preguntas de personalizacion.",
    input_schema: { type: "object", properties: {} },
  },
  askMultipleChoiceTool,
  {
    name: "send_welcome_audio",
    description: "Envia el audio de bienvenida de Sebastian. Usar una sola vez, al inicio de la conversacion.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "log_personalization_notes",
    description:
      "Guarda el resumen de las respuestas de personalizacion en el pedido de Shopify y notifica al equipo. Llamar una sola vez, cuando ya se tienen todas las respuestas necesarias. Esto tambien cierra el flujo.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Resumen claro de las respuestas (edad, sintoma/zona, cuando ocurre, frecuencia) y la variante o formula recomendada segun la guia.",
        },
      },
      required: ["summary"],
    },
  },
];

async function runPersonalizationTool(name, input, ctx) {
  switch (name) {
    case "get_order_line_items": {
      const order = await shopify.getOrderForAutomation(ctx.orderName);
      return order ? order.lineItems : { message: "No se pudo obtener el pedido." };
    }
    case "ask_multiple_choice": {
      const ok = await whatsapp.sendInteractiveQuestion(ctx.phone, input.question, input.options);
      if (ok) {
        conversationLog.logMessage(ctx.phone, "out", `${input.question} (${input.options.join(" / ")})`);
      }
      return { sent: ok, __terminal: true };
    }
    case "send_welcome_audio": {
      if (!SEBASTIAN_WELCOME_AUDIO_URL) return { message: "No hay audio de bienvenida configurado todavia." };
      const ok = await whatsapp.sendAudioMessage(ctx.phone, SEBASTIAN_WELCOME_AUDIO_URL);
      return { sent: ok };
    }
    case "log_personalization_notes": {
      await shopify.appendOrderNote(ctx.orderId, `PERSONALIZACION (via WhatsApp):\n${input.summary}`);
      await shopify.addOrderTags(ctx.orderId, ["tm-personalizacion-completa"]);
      await shopify.removeOrderTags(ctx.orderId, ["tm-personalizacion-enviada"]);
      await notify.sendInternalNotification(
        `Personalizacion lista - Pedido ${ctx.orderName}`,
        `El cliente respondio las preguntas de personalizacion del pedido ${ctx.orderName}.\n\n${input.summary}`
      );
      setSessionMode(ctx.phone, "normal", null, null);
      return { logged: true };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// MODO USO (post-entrega, cuando el pedido ya deberia haber llegado)
// ---------------------------------------------------------------------------

function usageSystemPrompt(orderName) {
  return `Estas conduciendo el flujo de MODO DE USO post-entrega de Tierra Miel para el
pedido ${orderName}, por WhatsApp, en espanol de Chile, tono calido y cercano.

Ya se le pregunto al cliente si su pedido llego bien. Este es su mensaje de respuesta.

INSTRUCCIONES:
- Si esta es la primera respuesta del cliente en esta conversacion y todavia no confirmo
  la entrega, usa ask_multiple_choice con la pregunta "¿Tu pedido ya llegó?" y opciones
  ["Sí, ya llegó", "Aún no"] en vez de preguntarlo en texto plano.
- Si el cliente confirma que el pedido llego (o no dice lo contrario), usa la herramienta
  get_usage_instructions para obtener el modo de uso de cada producto de su pedido, y
  arma un mensaje con esta estructura:
  Apertura breve tipo "Aqui tienes un resumen rapido de como usar cada producto:"
  Un bloque por producto: *Nombre del producto* seguido del modo de uso en 1-2 lineas,
  y el link "Ver ficha completa: [link]" si esta disponible.
  Cierre invitando a escribir si tienen dudas y pidiendo amablemente una resena.
- Si el cliente dice que el pedido NO ha llegado todavia, no mandes las instrucciones de
  uso todavia - discúlpate por la demora, ofrece revisar el tracking, y no llames a
  complete_usage_flow (vamos a reintentar mas adelante).
- Una vez mandado el resumen de modo de uso, usa la herramienta complete_usage_flow para
  cerrar el flujo (esto tambien manda el audio de cierre de Carolina, la fundadora).
- No uses markdown pesado; WhatsApp solo soporta *negrita*, _cursiva_ y listas con guiones.`;
}

const usageTools = [
  {
    name: "get_usage_instructions",
    description: "Devuelve el modo de uso de cada producto comprado en este pedido, con su link de ficha.",
    input_schema: { type: "object", properties: {} },
  },
  askMultipleChoiceTool,
  {
    name: "complete_usage_flow",
    description: "Cierra el flujo de modo de uso: manda el audio de cierre de Carolina y marca el pedido como completado. Llamar solo despues de haber mandado el resumen de modo de uso.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runUsageTool(name, input, ctx) {
  switch (name) {
    case "ask_multiple_choice": {
      const ok = await whatsapp.sendInteractiveQuestion(ctx.phone, input.question, input.options);
      if (ok) {
        conversationLog.logMessage(ctx.phone, "out", `${input.question} (${input.options.join(" / ")})`);
      }
      return { sent: ok, __terminal: true };
    }
    case "get_usage_instructions": {
      const order = await shopify.getOrderForAutomation(ctx.orderName);
      if (!order) return { message: "No se pudo obtener el pedido." };
      const blocks = buildUsageBlocks(order.lineItems, process.env.SHOPIFY_STORE_DOMAIN);
      return blocks.length ? blocks : { message: "Ninguno de los productos de este pedido tiene modo de uso en la libreria." };
    }
    case "complete_usage_flow": {
      if (CAROLINA_CLOSING_AUDIO_URL) {
        await whatsapp.sendAudioMessage(ctx.phone, CAROLINA_CLOSING_AUDIO_URL);
      }
      await shopify.addOrderTags(ctx.orderId, ["tm-modo-uso-completo"]);
      await shopify.removeOrderTags(ctx.orderId, ["tm-usage-enviado"]);
      setSessionMode(ctx.phone, "normal", null, null);
      return { completed: true };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Loop generico de tool-use, parametrizado por modo
// ---------------------------------------------------------------------------

async function runToolUseLoop({ systemPrompt, tools, runTool, messages, ctx }) {
  let finalText = null;
  const MAX_TOOL_ROUNDS = 6;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");

    if (toolUses.length === 0) {
      finalText = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    let hitTerminalTool = false;
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        let result;
        try {
          result = await runTool(tu.name, tu.input, ctx);
        } catch (err) {
          console.error(`Error ejecutando tool ${tu.name}:`, err);
          result = { error: err.message };
        }
        if (result?.__terminal) hitTerminalTool = true;
        return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) };
      })
    );

    messages.push({ role: "user", content: toolResults });

    // Algunas herramientas (ej ask_multiple_choice) ya mandan el mensaje al cliente
    // como efecto secundario - no hace falta pedirle a Claude texto adicional este turno.
    if (hitTerminalTool) {
      finalText = "";
      break;
    }
  }

  return { finalText, messages };
}

/**
 * Procesa un mensaje entrante de un cliente y devuelve el texto de respuesta.
 * Mantiene el historial de conversacion por numero de telefono, y usa el modo
 * (normal / personalization / usage) para decidir que system prompt y herramientas usar.
 */
async function handleMessage(phone, userText) {
  appendMessage(phone, "user", userText);
  const session = getSession(phone);
  const messages = [...session.messages];

  let config;
  if (session.mode === "personalization" && session.orderId) {
    config = {
      systemPrompt: personalizationSystemPrompt(session.orderName),
      tools: personalizationTools,
      runTool: runPersonalizationTool,
      ctx: { phone, orderId: session.orderId, orderName: session.orderName },
    };
  } else if (session.mode === "usage" && session.orderId) {
    config = {
      systemPrompt: usageSystemPrompt(session.orderName),
      tools: usageTools,
      runTool: runUsageTool,
      ctx: { phone, orderId: session.orderId, orderName: session.orderName },
    };
  } else {
    config = {
      systemPrompt: NORMAL_SYSTEM_PROMPT,
      tools: normalTools,
      runTool: runNormalTool,
      ctx: phone,
    };
  }

  let finalText, updatedMessages;
  try {
    ({ finalText, messages: updatedMessages } = await runToolUseLoop({ ...config, messages }));
  } catch (err) {
    // Si el historial quedo en un estado invalido (ej un tool_result huerfano
    // por un bug pasado), la API de Anthropic rechaza la llamada entera y la
    // conversacion queda rota para siempre con esa persona. Nos recuperamos
    // solos: limpiamos el historial y reintentamos una vez desde cero.
    console.error(`handleMessage: fallo con historial existente para ${phone}, reintentando con historial limpio:`, err);
    session.messages = [];
    const freshMessages = [{ role: "user", content: userText }];
    ({ finalText, messages: updatedMessages } = await runToolUseLoop({ ...config, messages: freshMessages }));
  }

  // finalText === "" es un caso valido: significa que una herramienta (ej
  // ask_multiple_choice) ya le mando el mensaje al cliente como efecto secundario,
  // y no hay que mandar nada mas. finalText === null si es un error real.
  const text =
    finalText === null
      ? "Disculpa, tuve un problema procesando tu consulta. ¿Puedes intentar de nuevo o reformularla?"
      : finalText;

  session.messages = safeTrimMessages(updatedMessages, 20);
  session.lastActive = Date.now();

  return text;
}

module.exports = { handleMessage };
