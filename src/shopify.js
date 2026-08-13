// Cliente minimo para la Shopify Admin GraphQL API.
// Requiere SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_API_TOKEN (custom app con scopes
// read_products, read_orders, read_customers).

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

async function shopifyGraphQL(query, variables = {}) {
  if (!STORE_DOMAIN || !ADMIN_TOKEN) {
    throw new Error(
      "Faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_API_TOKEN en las variables de entorno."
    );
  }

  const res = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function money(amountSet) {
  if (!amountSet) return null;
  const { amount, currencyCode } = amountSet.shopMoney || amountSet;
  return `${Number(amount).toLocaleString("es-CL")} ${currencyCode}`;
}

/** Busca productos por texto libre (titulo, tag, tipo de producto). */
async function searchProducts(searchTerm, limit = 5) {
  const query = `
    query SearchProducts($q: String!, $first: Int!) {
      products(first: $first, query: $q) {
        edges {
          node {
            title
            handle
            status
            onlineStoreUrl
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
            totalInventory
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q: searchTerm, first: limit });
  return data.products.edges.map(({ node }) => {
    const min = node.priceRangeV2.minVariantPrice;
    const max = node.priceRangeV2.maxVariantPrice;
    const priceLabel =
      min.amount === max.amount
        ? `${Number(min.amount).toLocaleString("es-CL")} ${min.currencyCode}`
        : `${Number(min.amount).toLocaleString("es-CL")}-${Number(
            max.amount
          ).toLocaleString("es-CL")} ${min.currencyCode}`;
    return {
      title: node.title,
      price: priceLabel,
      inStock: node.totalInventory > 0,
      url:
        node.onlineStoreUrl ||
        `https://${STORE_DOMAIN.replace(".myshopify.com", "")}.com/products/${node.handle}`,
    };
  });
}

/** Busca un pedido puntual por su numero (ej: "1001" o "#1001"). */
async function getOrderStatus(orderNumber) {
  const cleaned = String(orderNumber).replace("#", "").trim();
  const query = `
    query OrderStatus($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            fulfillments(first: 5) {
              trackingInfo { number url company }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q: `name:${cleaned}` });
  const edge = data.orders.edges[0];
  if (!edge) return null;
  const o = edge.node;
  return {
    name: o.name,
    createdAt: o.createdAt,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    total: money(o.totalPriceSet),
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo),
  };
}

/** Lista los pedidos recientes de un cliente por email o telefono. */
async function getCustomerOrders(identifier, limit = 5) {
  const isEmail = identifier.includes("@");
  const q = isEmail ? `email:${identifier}` : `phone:${identifier}`;
  const query = `
    query CustomerOrders($q: String!, $first: Int!) {
      orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q, first: limit });
  return data.orders.edges.map(({ node }) => ({
    name: node.name,
    createdAt: node.createdAt,
    financialStatus: node.displayFinancialStatus,
    fulfillmentStatus: node.displayFulfillmentStatus,
    total: money(node.totalPriceSet),
  }));
}

/** Trae una orden completa (line items, direccion de envio, telefono, tags) por su nombre (ej "1310"). */
async function getOrderForAutomation(orderNumber) {
  const cleaned = String(orderNumber).replace("#", "").trim();
  const query = `
    query OrderFull($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id
            name
            note
            tags
            phone
            customer { firstName lastName phone email }
            shippingAddress { province provinceCode countryCodeV2 phone }
            lineItems(first: 20) {
              edges { node { title quantity variant { product { handle } } } }
            }
            fulfillments(first: 5) {
              trackingInfo { number url company }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q: `name:${cleaned}` });
  const edge = data.orders.edges[0];
  if (!edge) return null;
  const o = edge.node;
  return {
    id: o.id,
    name: o.name,
    note: o.note,
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo)[0] || null,
    tags: o.tags,
    phone: o.phone || o.customer?.phone || o.shippingAddress?.phone || null,
    customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" "),
    email: o.customer?.email || null,
    province: o.shippingAddress?.province || null,
    lineItems: o.lineItems.edges.map(({ node }) => ({
      title: node.title,
      quantity: node.quantity,
      handle: node.variant?.product?.handle || null,
    })),
  };
}

/** Agrega texto a la nota de un pedido (sin borrar lo que ya habia). */
async function appendOrderNote(orderId, textToAppend) {
  const getQuery = `query($id: ID!) { order(id: $id) { note } }`;
  const current = await shopifyGraphQL(getQuery, { id: orderId });
  const existing = current.order?.note || "";
  const newNote = existing ? `${existing}\n---\n${textToAppend}` : textToAppend;

  const mutation = `
    mutation($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, { input: { id: orderId, note: newNote } });
  const errors = data.orderUpdate.userErrors;
  if (errors?.length) throw new Error(`Shopify orderUpdate error: ${JSON.stringify(errors)}`);
  return data.orderUpdate.order;
}

/** Agrega tags a un pedido (no reemplaza los existentes). */
async function addOrderTags(orderId, tags) {
  const mutation = `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, { id: orderId, tags });
  if (data.tagsAdd.userErrors?.length) {
    throw new Error(`Shopify tagsAdd error: ${JSON.stringify(data.tagsAdd.userErrors)}`);
  }
}

/** Quita tags de un pedido. */
async function removeOrderTags(orderId, tags) {
  const mutation = `
    mutation($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, { id: orderId, tags });
  if (data.tagsRemove.userErrors?.length) {
    throw new Error(`Shopify tagsRemove error: ${JSON.stringify(data.tagsRemove.userErrors)}`);
  }
}

/** Guarda un metafield en un pedido (namespace fijo "tierra_miel"). */
async function setOrderMetafield(orderId, key, value, type = "single_line_text_field") {
  const mutation = `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, {
    metafields: [{ ownerId: orderId, namespace: "tierra_miel", key, value, type }],
  });
  if (data.metafieldsSet.userErrors?.length) {
    throw new Error(`Shopify metafieldsSet error: ${JSON.stringify(data.metafieldsSet.userErrors)}`);
  }
}

/** Lee un metafield de un pedido (namespace fijo "tierra_miel"). */
async function getOrderMetafield(orderId, key) {
  const query = `
    query($id: ID!, $key: String!) {
      order(id: $id) { metafield(namespace: "tierra_miel", key: $key) { value } }
    }
  `;
  const data = await shopifyGraphQL(query, { id: orderId, key });
  return data.order?.metafield?.value || null;
}

/** Busca pedidos por tag (para el scheduler que revisa pendientes). */
async function findOrdersByTag(tag, first = 25) {
  const query = `
    query($q: String!, $first: Int!) {
      orders(first: $first, query: $q) {
        edges { node { id name } }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q: `tag:'${tag}'`, first });
  return data.orders.edges.map(({ node }) => node);
}

/**
 * Red de seguridad: busca pedidos creados en las ultimas N horas que no tengan
 * NINGUNA etiqueta "tm-" (senal de que nuestra automatizacion nunca los toco,
 * por ejemplo porque el webhook no llego durante un reinicio del servidor).
 */
async function findRecentOrdersMissingAutomation(hours = 48, first = 50) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const query = `
    query($q: String!, $first: Int!) {
      orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { node { id name tags } }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q: `created_at:>'${since}'`, first });
  return data.orders.edges
    .map(({ node }) => node)
    .filter((o) => !o.tags.some((t) => t.startsWith("tm-")));
}

module.exports = {
  findRecentOrdersMissingAutomation,
  searchProducts,
  getOrderStatus,
  getCustomerOrders,
  getOrderForAutomation,
  appendOrderNote,
  addOrderTags,
  removeOrderTags,
  setOrderMetafield,
  getOrderMetafield,
  findOrdersByTag,
};
