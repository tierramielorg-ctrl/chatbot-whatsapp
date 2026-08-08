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

module.exports = { searchProducts, getOrderStatus, getCustomerOrders };
