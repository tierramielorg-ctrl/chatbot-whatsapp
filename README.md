# Tierra Miel — Chatbot de WhatsApp

Bot conversacional para WhatsApp Business de Tierra Miel. Usa **Claude** (Anthropic) para
conversar y llama en vivo a **Shopify** para:

- Buscar productos y precios reales del catálogo.
- Consultar el estado de un pedido por número.
- Listar los pedidos recientes de un cliente por email o teléfono.

## Arquitectura

```
WhatsApp Cloud API  <-- webhook -->  este servidor (Express)  <-- tool calls -->  Shopify Admin API
                                              |
                                              v
                                        Claude (Anthropic API)
```

- `src/server.js` — servidor Express con el webhook de WhatsApp.
- `src/whatsapp.js` — verificación de webhook, firma, parseo y envío de mensajes.
- `src/claudeAgent.js` — prompt del bot, definición de herramientas y loop de tool-use con Claude.
- `src/shopify.js` — llamadas a la Shopify Admin GraphQL API.
- `src/session.js` — historial de conversación en memoria por número de teléfono (se resetea si el proceso se reinicia).

## 1. Requisitos previos

### a) Meta / WhatsApp Business Cloud API

1. Crea una app en [developers.facebook.com](https://developers.facebook.com/apps) tipo "Business".
2. Agrega el producto **WhatsApp**.
3. En el panel de WhatsApp > API Setup obtendrás:
   - Un **Phone Number ID** (no es el número de teléfono, es un ID).
   - Un **token temporal** de 24h para pruebas. Para producción, genera un **token permanente**
     creando un System User en Meta Business Suite y asignándole el activo de WhatsApp
     (Business Settings > Users > System Users).
4. Anota el **App Secret** (Settings > Basic) — se usa para verificar que los webhooks realmente
   vienen de Meta.
5. Verifica el número de teléfono de WhatsApp Business que vas a usar (puede ser el mismo que ya
   usa Tierra Miel o uno nuevo dedicado al bot).

### b) Shopify — Custom App

1. En el admin de Shopify: **Settings > Apps and sales channels > Develop apps**.
2. Crea una app nueva, ej. "Chatbot WhatsApp".
3. Configura Admin API scopes: `read_products`, `read_orders`, `read_customers`.
4. Instala la app y copia el **Admin API access token** (`shpat_...`).
5. Tu `SHOPIFY_STORE_DOMAIN` es el dominio `*.myshopify.com` de la tienda (no `tierramiel.org`).

### c) Anthropic

1. Consigue una API key en [console.anthropic.com](https://console.anthropic.com).

## 2. Configuración local

```bash
cd chatbot-whatsapp
npm install
cp .env.example .env
```

Completa `.env` con los valores reales de los 3 pasos anteriores. `WHATSAPP_VERIFY_TOKEN` es un
string que tú mismo inventas (ej. un password largo aleatorio); lo vas a repetir en el panel de
Meta al configurar el webhook.

```bash
npm run dev
```

El servidor queda escuchando en `http://localhost:3000`. Usa [ngrok](https://ngrok.com) (o similar)
para exponerlo públicamente mientras pruebas:

```bash
ngrok http 3000
```

## 3. Configurar el webhook en Meta

En el panel de WhatsApp > Configuration:

- **Callback URL**: `https://<tu-dominio-o-ngrok>/webhook`
- **Verify token**: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
- Suscríbete al campo **`messages`**.

Meta hará un GET de verificación automáticamente; si `verify token` coincide, se activa.

## 4. Probar

Escríbele por WhatsApp al número de prueba/producción configurado en Meta. El mensaje debería
llegar al webhook, pasar por Claude, y (si aplica) consultar Shopify antes de responder.

Prueba casos como:
- "hola, tienen miel de ulmo?"
- "cuánto cuesta el polen?"
- "cuál es el estado de mi pedido 1032?"

## 5. Deploy a producción (Railway o Render)

1. Sube este proyecto a un repo de GitHub (o conecta la carpeta directo si la plataforma lo permite).
2. En Railway/Render: **New Project/Service > Deploy from GitHub repo**.
3. Configura las variables de entorno (las mismas de `.env`) en el panel del servicio — **nunca subas
   el archivo `.env` al repo** (ya está en `.gitignore`).
4. Start command: `npm start`.
5. Una vez desplegado, actualiza la **Callback URL** en el panel de Meta a la URL pública del
   servicio (ej. `https://tierra-miel-bot.up.railway.app/webhook`).

## Límites conocidos / próximos pasos

- **Ventana de 24h**: WhatsApp permite responder libremente solo dentro de las 24h desde el último
  mensaje del cliente. Para mensajes proactivos (ej. "tu pedido ya salió") fuera de esa ventana se
  necesitan **message templates** pre-aprobados por Meta — no están implementados en esta v1.
- **Sesión en memoria**: el historial de conversación vive en RAM del proceso; se pierde si el
  servicio se reinicia o si corres más de una instancia. Para escalar, migrar `src/session.js` a
  Redis o una tabla en base de datos.
- **Solo texto**: el bot ignora imágenes/audio/documentos por ahora; responde pidiendo texto.
- **Sin escalamiento a humano real**: el bot dice que puede derivar a una persona, pero no hay una
  integración que notifique de verdad al equipo. Se podría agregar, por ejemplo, un mensaje a un
  Slack/email interno cuando el bot detecte que no puede resolver algo.
- **Un solo idioma**: prompt en español. Si Tierra Miel atiende clientes en otro idioma, ajustar
  `SYSTEM_PROMPT` en `src/claudeAgent.js`.
