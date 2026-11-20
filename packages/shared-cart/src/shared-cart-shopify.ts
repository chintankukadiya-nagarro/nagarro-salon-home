import { getAdminAccessToken, invalidateAdminAccessToken, type AdminCredentialEnv } from "./shared-cart-admin";
import { APPROVED_VENDORS, CART_METAFIELD, COUNTRY } from "./shared-cart-rules";
import type { AdminMetafields, CartShopify, StoredCart } from "./shared-cart-service";

const API_VERSION = "2026-10";

const CART_FIELDS = `
  id checkoutUrl totalQuantity note updatedAt
  attributes { key value }
  discountCodes { applicable code }
  cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } checkoutChargeAmount { amount currencyCode } }
  lines(first: 250) {
    nodes {
      id quantity
      attributes { key value }
      sellingPlanAllocation { sellingPlan { id } }
      cost { totalAmount { amount currencyCode } amountPerQuantity { amount currencyCode } }
      merchandise { ... on ProductVariant { id title product { title handle vendor } } }
    }
  }
`;

export type SharedCartEnv = AdminCredentialEnv & {
  PUBLIC_STORE_DOMAIN?: string;
  SHOP_ID?: string;
  PRIVATE_STOREFRONT_API_TOKEN?: string;
  SHARED_CART_STOREFRONT_TOKEN?: string;
};

type GraphQL = { status: number; data?: Record<string, unknown> | null; errors?: { message: string }[] };

async function postGraph(url: string, headers: Record<string, string>, query: string, variables: Record<string, unknown>): Promise<GraphQL> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) return { status: response.status, errors: [{ message: "Shopify request failed" }] };
  return { status: response.status, ...(await response.json() as Omit<GraphQL, "status">) };
}

export function createSharedCartClients(env: SharedCartEnv): { admin: AdminMetafields; shopify: CartShopify } | null {
  const domain = env.PUBLIC_STORE_DOMAIN;
  const storefrontToken = env.SHARED_CART_STOREFRONT_TOKEN || env.PRIVATE_STOREFRONT_API_TOKEN;
  if (!domain || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !storefrontToken) return null;
  const privateToken: string = storefrontToken;
  const adminUrl = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const storefrontUrl = `https://${domain}/api/${API_VERSION}/graphql.json`;

  async function adminGraph(query: string, variables: Record<string, unknown>) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getAdminAccessToken(env);
      const body = await postGraph(adminUrl, { "X-Shopify-Access-Token": token }, query, variables);
      if (body.status !== 401) return body;
      invalidateAdminAccessToken(env);
    }
    return { status: 401, errors: [{ message: "Shopify request failed" }] };
  }

  const admin: AdminMetafields = {
    async read(customerGid, key) {
      const body = await adminGraph(`
        query CartMetafield($id: ID!, $namespace: String!, $key: String!) {
          customer(id: $id) { metafield(namespace: $namespace, key: $key) { value compareDigest } }
        }`, { id: customerGid, namespace: CART_METAFIELD.namespace, key });
      const metafield = (body.data?.customer as { metafield?: { value?: string | null; compareDigest?: string | null } | null } | null)?.metafield;
      return { value: metafield?.value ?? null, compareDigest: metafield?.compareDigest ?? null };
    },
    async compareAndSet(customerGid, key, value, compareDigest) {
      const body = await adminGraph(`
        mutation SetCartMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { metafields { compareDigest } userErrors { message } }
        }`, {
        metafields: [{
          ownerId: customerGid,
          namespace: CART_METAFIELD.namespace,
          key,
          type: CART_METAFIELD.type,
          value,
          compareDigest,
        }],
      });
      const payload = body.data?.metafieldsSet as { metafields?: { compareDigest?: string | null }[] | null; userErrors?: { message: string }[] } | undefined;
      const message = payload?.userErrors?.[0]?.message ?? body.errors?.[0]?.message;
      if (!payload || (payload.userErrors?.length ?? 0) > 0 || body.errors?.length) {
        return { ok: false, message: customerAccessMessage(message) };
      }
      return { ok: true, compareDigest: payload.metafields?.[0]?.compareDigest ?? "" };
    },
  };

  const shopify: CartShopify = {
    async catalogReady(buyerIp) {
      const body = await storefront(buyerIp, `
        query SharedCatalog($country: CountryCode!, $language: LanguageCode!) @inContext(country: $country, language: $language) {
          lrp: collection(handle: "la-roche-posay") { handle products(first: 1) { nodes { vendor } } }
          ker: collection(handle: "kerastase") { handle products(first: 1) { nodes { vendor } } }
        }`, {});
      const data = body.data as { lrp?: { handle?: string; products?: { nodes?: { vendor?: string }[] } } | null; ker?: { handle?: string; products?: { nodes?: { vendor?: string }[] } } | null } | null;
      const lrpVendor = data?.lrp?.products?.nodes?.[0]?.vendor;
      const kerVendor = data?.ker?.products?.nodes?.[0]?.vendor;
      return data?.lrp?.handle === "la-roche-posay"
        && data?.ker?.handle === "kerastase"
        && lrpVendor === APPROVED_VENDORS[0]
        && kerVendor === APPROVED_VENDORS[1];
    },
    async variants(ids, buyerIp) {
      const body = await storefront(buyerIp, `
        query SharedVariants($ids: [ID!]!, $country: CountryCode!, $language: LanguageCode!) @inContext(country: $country, language: $language) {
          nodes(ids: $ids) { __typename id ... on ProductVariant { product { title vendor } } }
        }`, { ids });
      const nodes = body.data?.nodes;
      return Array.isArray(nodes) ? nodes as Awaited<ReturnType<CartShopify["variants"]>> : [];
    },
    async loadCart(cartId, buyerIp) {
      const body = await storefront(buyerIp, `
        query SharedCart($id: ID!, $country: CountryCode!, $language: LanguageCode!) @inContext(country: $country, language: $language) {
          cart(id: $id) { ${CART_FIELDS} }
        }`, { id: cartId });
      return (body.data?.cart as StoredCart | null) ?? null;
    },
    async mutate(mutation, variables, buyerIp) {
      const document = mutationDocument(mutation);
      const body = await storefront(buyerIp, document, variables);
      const key = mutation === "create" ? "cartCreate" : mutation === "add" ? "cartLinesAdd" : mutation === "update" ? "cartLinesUpdate" : mutation === "remove" ? "cartLinesRemove" : mutation === "note" ? "cartNoteUpdate" : mutation === "discount" ? "cartDiscountCodesUpdate" : mutation === "attributes" ? "cartAttributesUpdate" : "cartBuyerIdentityUpdate";
      const payload = body.data?.[key] as { cart?: StoredCart | null; userErrors?: { message: string }[]; warnings?: { message: string }[] } | undefined;
      return {
        cart: payload?.cart ?? null,
        userErrors: payload?.userErrors ?? (body.errors ? [{ message: "Storefront request failed" }] : []),
        warnings: payload?.warnings ?? [],
      };
    },
  };

  async function storefront(buyerIp: string, query: string, variables: Record<string, unknown>) {
    return postGraph(storefrontUrl, {
      "Shopify-Storefront-Private-Token": privateToken,
      "Shopify-Storefront-Buyer-IP": buyerIp,
    }, query, { country: COUNTRY, language: "EN", ...variables });
  }

  return { admin, shopify };
}

function customerAccessMessage(message: string | undefined): string {
  if (message && /not approved to access the Customer|Access denied for metafieldsSet/i.test(message)) {
    return "This app is not approved to save a cart on the customer. Approve protected customer data access, then try again.";
  }
  if (!message || message.length > 180) return "The shared cart could not be saved.";
  return message;
}

function mutationDocument(mutation: Parameters<CartShopify["mutate"]>[0]): string {
  const header = `$country: CountryCode!, $language: LanguageCode!`;
  const context = `@inContext(country: $country, language: $language)`;
  const payload = `cart { ${CART_FIELDS} } userErrors { message } warnings { code message target }`;
  if (mutation === "create") {
    return `mutation CartCreate($input: CartInput!, ${header}) ${context} { cartCreate(input: $input) { ${payload} } }`;
  }
  if (mutation === "add") return `mutation CartAdd($cartId: ID!, $lines: [CartLineInput!]!, ${header}) ${context} { cartLinesAdd(cartId: $cartId, lines: $lines) { ${payload} } }`;
  if (mutation === "update") return `mutation CartUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!, ${header}) ${context} { cartLinesUpdate(cartId: $cartId, lines: $lines) { ${payload} } }`;
  if (mutation === "remove") return `mutation CartRemove($cartId: ID!, $lineIds: [ID!]!, ${header}) ${context} { cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { ${payload} } }`;
  if (mutation === "note") return `mutation CartNote($cartId: ID!, $note: String!, ${header}) ${context} { cartNoteUpdate(cartId: $cartId, note: $note) { ${payload} } }`;
  if (mutation === "discount") return `mutation CartDiscount($cartId: ID!, $discountCodes: [String!]!, ${header}) ${context} { cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) { ${payload} } }`;
  if (mutation === "attributes") return `mutation CartAttributes($cartId: ID!, $attributes: [AttributeInput!]!, ${header}) ${context} { cartAttributesUpdate(cartId: $cartId, attributes: $attributes) { ${payload} } }`;
  return `mutation CartBuyer($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!, ${header}) ${context} { cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) { ${payload} } }`;
}

const appNamespaces = new Map<string, string>();

export async function customerMetafieldNamespace(env: SharedCartEnv): Promise<string> {
  const domain = env.PUBLIC_STORE_DOMAIN;
  if (!domain) throw new Error("The shared cart could not be saved.");
  const cached = appNamespaces.get(domain);
  if (cached) return cached;
  const token = await getAdminAccessToken(env);
  const body = await postGraph(
    `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
    { "X-Shopify-Access-Token": token },
    `query CartNamespace($ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(first: 50, ownerType: $ownerType) { nodes { namespace key } }
    }`,
    { ownerType: "CUSTOMER" },
  );
  const nodes = body.data?.metafieldDefinitions as { nodes?: { namespace?: string; key?: string }[] } | undefined;
  const namespace = nodes?.nodes?.find((node) => node.key === CART_METAFIELD.cartKey && node.namespace?.startsWith("app--"))?.namespace;
  if (!namespace) throw new Error("The shared cart could not be saved.");
  appNamespaces.set(domain, namespace);
  return namespace;
}

export function sharedCartReady(env: SharedCartEnv): boolean {
  return Boolean(
    env.PUBLIC_STORE_DOMAIN
    && env.SHOP_ID
    && env.SHOPIFY_CLIENT_ID
    && env.SHOPIFY_CLIENT_SECRET
    && (env.SHARED_CART_STOREFRONT_TOKEN || env.PRIVATE_STOREFRONT_API_TOKEN),
  );
}
