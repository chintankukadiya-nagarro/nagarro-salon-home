import type { ShopifyRequestContext } from "@shopify/hydrogen";
import { CustomerAccountApiError, createCustomerAccountClient, gql } from "@shopify/hydrogen/customer-account";

import {
  APPROVED_VENDORS,
  CART_METAFIELD,
  COUNTRY,
  PUBLIC_CART_ID,
  SHOP_DOMAIN,
  customerGidFromProxy,
  hashSourceCart,
  isApprovedVendor,
  isCustomerGid,
  linesToMerge,
  parseAttributes,
  parseLineId,
  parseMerchandiseId,
  parseMerges,
  parseQuantity,
  rejectedMerchandise,
  verifyProxySignature,
  type CartLineInput,
  type ExistingLine,
  type MergeReceipt,
} from "./shared-cart-rules";
import { createSharedCartClients, type SharedCartEnv } from "./shared-cart-shopify";

export type MetafieldSlot = { value: string | null; compareDigest: string | null };

export type AdminMetafields = {
  read(customerGid: string, key: string): Promise<MetafieldSlot>;
  compareAndSet(
    customerGid: string,
    key: string,
    value: string,
    compareDigest: string | null,
  ): Promise<{ ok: true; compareDigest: string } | { ok: false; message?: string }>;
};

export function createMemoryMetafields(): AdminMetafields {
  const slots = new Map<string, { value: string; compareDigest: string }>();
  let sequence = 0;
  const slotKey = (customerGid: string, key: string) => `${customerGid}:${key}`;
  return {
    async read(customerGid, key) {
      const slot = slots.get(slotKey(customerGid, key));
      return slot ? { value: slot.value, compareDigest: slot.compareDigest } : { value: null, compareDigest: null };
    },
    async compareAndSet(customerGid, key, value, compareDigest) {
      const id = slotKey(customerGid, key);
      const current = slots.get(id);
      if (compareDigest === null) {
        if (current) return { ok: false };
      } else if (!current || current.compareDigest !== compareDigest) {
        return { ok: false };
      }
      const next = { value, compareDigest: `digest-${++sequence}` };
      slots.set(id, next);
      return { ok: true, compareDigest: next.compareDigest };
    },
  };
}

type Money = { amount: string; currencyCode: string };
type CartLineNode = {
  id: string;
  quantity: number;
  attributes: { key: string; value: string | null }[];
  sellingPlanAllocation: { sellingPlan: { id: string } } | null;
  cost: { totalAmount: Money; amountPerQuantity: Money };
  merchandise: { id: string; title: string; product: { title: string; handle: string; vendor: string } } | null;
};

export type StoredCart = {
  id: string;
  checkoutUrl: string | null;
  totalQuantity: number;
  note: string | null;
  attributes: { key: string; value: string | null }[];
  discountCodes: { applicable: boolean; code: string }[];
  cost: { subtotalAmount: Money; totalAmount: Money; checkoutChargeAmount?: Money };
  lines: { nodes: CartLineNode[] };
};

export type CartShopify = {
  catalogReady(buyerIp: string): Promise<boolean>;
  variants(ids: string[], buyerIp: string): Promise<({ __typename?: string; id?: string; product?: { title?: string | null; vendor?: string | null } | null } | null)[]>;
  loadCart(cartId: string, buyerIp: string): Promise<StoredCart | null>;
  mutate(
    mutation: "create" | "add" | "update" | "remove" | "note" | "discount" | "attributes" | "buyer",
    variables: Record<string, unknown>,
    buyerIp: string,
  ): Promise<{ cart: StoredCart | null; userErrors: { message: string }[]; warnings: { message: string }[] }>;
};

export type Identity = {
  shop: string;
  customerGid: string;
  accessToken: string | null;
  buyerIp: string;
};

export type CartOp =
  | { op: "get" }
  | { op: "add"; lines: unknown }
  | { op: "update"; lines: unknown }
  | { op: "remove"; lineIds: unknown }
  | { op: "note"; note: unknown }
  | { op: "discount"; discountCodes: unknown }
  | { op: "discount-modify"; mode: unknown; code: unknown }
  | { op: "attributes"; attributes: unknown }
  | { op: "merge"; sourceCartId: unknown; lines: unknown }
  | { op: "checkout" };

type Deps = { admin: AdminMetafields; shopify: CartShopify; pepper: string };

type PublicBody = {
  cart: (Omit<StoredCart, "id"> & { id: typeof PUBLIC_CART_ID }) | null;
  userErrors: { message: string }[];
  warnings: { message: string }[];
};

function present(cart: StoredCart | null, checkout: boolean): PublicBody["cart"] {
  if (!cart?.id) return null;
  return { ...cart, id: PUBLIC_CART_ID, checkoutUrl: checkout ? (cart.checkoutUrl ?? null) : null };
}

function empty(message?: string): PublicBody {
  return { cart: null, userErrors: message ? [{ message }] : [], warnings: [] };
}

function parseAddLines(value: unknown): CartLineInput[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return "Add at least one product.";
  const lines: CartLineInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return "A cart line is invalid.";
    const merchandiseId = parseMerchandiseId("merchandiseId" in entry ? entry.merchandiseId : undefined);
    const quantity = parseQuantity("quantity" in entry ? entry.quantity : undefined);
    const attributes = parseAttributes("attributes" in entry ? entry.attributes : undefined);
    const sellingPlanId = "sellingPlanId" in entry ? entry.sellingPlanId : undefined;
    if (!merchandiseId || quantity == null || quantity < 1 || !attributes) return "A cart line is invalid.";
    if (sellingPlanId != null && typeof sellingPlanId !== "string") return "A selling plan is invalid.";
    lines.push({ merchandiseId, quantity, attributes, ...(typeof sellingPlanId === "string" ? { sellingPlanId } : {}) });
  }
  return lines;
}

function existingLines(cart: StoredCart | null): ExistingLine[] {
  return (cart?.lines.nodes ?? []).flatMap((line) => {
    if (!line.merchandise?.id) return [];
    return [{
      merchandiseId: line.merchandise.id,
      quantity: line.quantity,
      sellingPlanId: line.sellingPlanAllocation?.sellingPlan.id,
      attributes: line.attributes,
    }];
  });
}

async function rejectUnknown(deps: Deps, identity: Identity, ids: string[]) {
  const nodes = await deps.shopify.variants([...new Set(ids)], identity.buyerIp);
  return rejectedMerchandise([...new Set(ids)], nodes).filter((item) => {
    const node = nodes.find((entry) => entry?.id === item.id);
    return !isApprovedVendor(node?.product?.vendor);
  });
}

async function readStoredCart(deps: Deps, identity: Identity): Promise<{ cart: StoredCart | null; digest: string | null }> {
  const slot = await deps.admin.read(identity.customerGid, CART_METAFIELD.cartKey);
  if (!slot.value) return { cart: null, digest: null };
  const cart = await deps.shopify.loadCart(slot.value, identity.buyerIp);
  return { cart, digest: slot.compareDigest };
}

async function claimCartId(deps: Deps, identity: Identity, cartId: string, compareDigest: string | null) {
  return deps.admin.compareAndSet(identity.customerGid, CART_METAFIELD.cartKey, cartId, compareDigest);
}

async function createCart(deps: Deps, identity: Identity, lines: CartLineInput[]) {
  const buyerIdentity: { countryCode: string; customerAccessToken?: string } = { countryCode: COUNTRY };
  if (identity.accessToken) buyerIdentity.customerAccessToken = identity.accessToken;
  const input = lines.length > 0 ? { lines, buyerIdentity } : { buyerIdentity };
  return deps.shopify.mutate("create", { input }, identity.buyerIp);
}

async function adoptWinner(deps: Deps, identity: Identity, lines: CartLineInput[]) {
  const winner = await deps.admin.read(identity.customerGid, CART_METAFIELD.cartKey);
  if (!winner.value) return null;
  if (lines.length === 0) return deps.shopify.loadCart(winner.value, identity.buyerIp);
  const added = await deps.shopify.mutate("add", { cartId: winner.value, lines }, identity.buyerIp);
  return added.cart ?? (await deps.shopify.loadCart(winner.value, identity.buyerIp));
}

async function storeFreshCart(deps: Deps, identity: Identity, lines: CartLineInput[], compareDigest: string | null) {
  const created = await createCart(deps, identity, lines);
  if (!created.cart) return created;
  const claimed = await claimCartId(deps, identity, created.cart.id, compareDigest);
  if (claimed.ok) return created;
  if (claimed.message) return { cart: null, userErrors: [{ message: claimed.message }], warnings: created.warnings };
  const winner = await adoptWinner(deps, identity, lines);
  return { cart: winner, userErrors: created.userErrors, warnings: created.warnings };
}

async function cartForWrite(deps: Deps, identity: Identity, lines: CartLineInput[]) {
  const current = await readStoredCart(deps, identity);
  if (current.cart) return { cart: current.cart, userErrors: [], warnings: [] };
  if (current.digest) return storeFreshCart(deps, identity, lines, current.digest);
  const slot = await deps.admin.read(identity.customerGid, CART_METAFIELD.cartKey);
  if (slot.value) {
    const loaded = await deps.shopify.loadCart(slot.value, identity.buyerIp);
    if (loaded) return { cart: loaded, userErrors: [], warnings: [] };
    return storeFreshCart(deps, identity, lines, slot.compareDigest);
  }
  return storeFreshCart(deps, identity, lines, null);
}

async function syncBuyer(deps: Deps, identity: Identity, cart: StoredCart | null) {
  if (!cart || !identity.accessToken) return cart;
  const result = await deps.shopify.mutate(
    "buyer",
    { cartId: cart.id, buyerIdentity: { countryCode: COUNTRY, customerAccessToken: identity.accessToken } },
    identity.buyerIp,
  );
  return result.cart ?? cart;
}

async function writeMerges(deps: Deps, identity: Identity, receipts: MergeReceipt[], digest: string | null) {
  const next = receipts.slice(-50);
  let cursor = digest;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const saved = await deps.admin.compareAndSet(
      identity.customerGid,
      CART_METAFIELD.mergesKey,
      JSON.stringify(next),
      cursor,
    );
    if (saved.ok) return true;
    const again = await deps.admin.read(identity.customerGid, CART_METAFIELD.mergesKey);
    cursor = again.compareDigest;
  }
  return false;
}

export async function handleSharedCart(deps: Deps, identity: Identity, operation: CartOp): Promise<{ status: number; body: PublicBody | { error: string } }> {
  if (!isCustomerGid(identity.customerGid) || identity.shop !== SHOP_DOMAIN) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (!(await deps.shopify.catalogReady(identity.buyerIp))) {
    return { status: 503, body: { error: "The shared catalog is not available for both brands." } };
  }
  if (operation.op === "get" || operation.op === "checkout") {
    const current = await readStoredCart(deps, identity);
    const cart = operation.op === "checkout" ? await syncBuyer(deps, identity, current.cart) : current.cart;
    return { status: 200, body: { cart: present(cart, operation.op === "checkout"), userErrors: [], warnings: [] } };
  }
  if (operation.op === "merge") {
    if (typeof operation.sourceCartId !== "string" || operation.sourceCartId.length < 8) {
      return { status: 400, body: empty("The anonymous cart could not be merged.") };
    }
    const parsed = parseAddLines(operation.lines);
    if (typeof parsed === "string") return { status: 400, body: empty(parsed) };
    const rejected = await rejectUnknown(deps, identity, parsed.map((line) => line.merchandiseId));
    if (rejected.length > 0) {
      const current = await readStoredCart(deps, identity);
      return { status: 200, body: { cart: present(current.cart, false), userErrors: rejected.map((item) => ({ message: `${item.title} is not in the shared catalog.` })), warnings: [] } };
    }
    const sourceHash = await hashSourceCart(operation.sourceCartId, deps.pepper);
    const slot = await deps.admin.read(identity.customerGid, CART_METAFIELD.mergesKey);
    const receipts = parseMerges(slot.value);
    const prior = receipts.find((entry) => entry.hash === sourceHash);
    if (prior?.status === "done") {
      const current = await readStoredCart(deps, identity);
      return { status: 200, body: { cart: present(current.cart, false), userErrors: [], warnings: [] } };
    }
    const openReceipts = prior ? receipts : [...receipts, { hash: sourceHash, status: "open" as const }];
    if (!prior) await writeMerges(deps, identity, openReceipts, slot.compareDigest);
    const current = await cartForWrite(deps, identity, []);
    const planned = linesToMerge(parsed, existingLines(current.cart), prior?.status === "open");
    const added = planned.length > 0 && current.cart
      ? await deps.shopify.mutate("add", { cartId: current.cart.id, lines: planned }, identity.buyerIp)
      : { cart: current.cart, userErrors: [], warnings: [] };
    if (added.userErrors.length === 0) {
      const latest = await deps.admin.read(identity.customerGid, CART_METAFIELD.mergesKey);
      const done = parseMerges(latest.value).map((entry) => entry.hash === sourceHash ? { ...entry, status: "done" as const } : entry);
      if (!done.some((entry) => entry.hash === sourceHash)) done.push({ hash: sourceHash, status: "done" });
      await writeMerges(deps, identity, done, latest.compareDigest);
    }
    return { status: 200, body: { cart: present(added.cart, false), userErrors: added.userErrors, warnings: added.warnings } };
  }
  if (operation.op === "add") {
    const parsed = parseAddLines(operation.lines);
    if (typeof parsed === "string") return { status: 400, body: empty(parsed) };
    const rejected = await rejectUnknown(deps, identity, parsed.map((line) => line.merchandiseId));
    if (rejected.length > 0) {
      const current = await readStoredCart(deps, identity);
      return { status: 200, body: { cart: present(current.cart, false), userErrors: rejected.map((item) => ({ message: `${item.title} is not in the shared catalog.` })), warnings: [] } };
    }
    const slot = await deps.admin.read(identity.customerGid, CART_METAFIELD.cartKey);
    if (!slot.value) {
      const created = await storeFreshCart(deps, identity, parsed, null);
      return { status: 200, body: { cart: present(created.cart, false), userErrors: created.userErrors, warnings: created.warnings } };
    }
    const loaded = await deps.shopify.loadCart(slot.value, identity.buyerIp);
    const base = loaded ? { cart: loaded, userErrors: [], warnings: [] } : await storeFreshCart(deps, identity, [], slot.compareDigest);
    if (!base.cart) return { status: 200, body: empty("The cart could not be created.") };
    const added = await deps.shopify.mutate("add", { cartId: base.cart.id, lines: parsed }, identity.buyerIp);
    return { status: 200, body: { cart: present(added.cart ?? base.cart, false), userErrors: added.userErrors, warnings: added.warnings } };
  }
  const current = await readStoredCart(deps, identity);
  if (!current.cart && operation.op !== "note" && operation.op !== "discount" && operation.op !== "discount-modify" && operation.op !== "attributes") {
    return { status: 200, body: empty("No cart exists. Add an item first.") };
  }
  const ready = current.cart ? { cart: current.cart, userErrors: [] as { message: string }[], warnings: [] as { message: string }[] } : await storeFreshCart(deps, identity, [], current.digest);
  if (!ready.cart) return { status: 200, body: empty("The cart could not be created.") };
  if (operation.op === "remove") {
    if (!Array.isArray(operation.lineIds) || operation.lineIds.some((id) => !parseLineId(id))) {
      return { status: 400, body: empty("A cart line is invalid.") };
    }
    const result = await deps.shopify.mutate("remove", { cartId: ready.cart.id, lineIds: operation.lineIds }, identity.buyerIp);
    return { status: 200, body: { cart: present(result.cart ?? ready.cart, false), userErrors: result.userErrors, warnings: result.warnings } };
  }
  if (operation.op === "update") {
    if (!Array.isArray(operation.lines)) return { status: 400, body: empty("A cart line is invalid.") };
    const lines = [];
    for (const entry of operation.lines) {
      if (!entry || typeof entry !== "object") return { status: 400, body: empty("A cart line is invalid.") };
      const id = parseLineId("id" in entry ? entry.id : undefined);
      const quantity = parseQuantity("quantity" in entry ? entry.quantity : undefined);
      if (!id || quantity == null) return { status: 400, body: empty("A cart line is invalid.") };
      lines.push({ id, quantity });
    }
    const removals = lines.filter((line) => line.quantity === 0).map((line) => line.id);
    const updates = lines.filter((line) => line.quantity > 0);
    let cart = ready.cart;
    let userErrors: { message: string }[] = [];
    let warnings: { message: string }[] = [];
    if (updates.length > 0) {
      const result = await deps.shopify.mutate("update", { cartId: cart.id, lines: updates }, identity.buyerIp);
      cart = result.cart ?? cart;
      userErrors = result.userErrors;
      warnings = result.warnings;
    }
    if (removals.length > 0) {
      const result = await deps.shopify.mutate("remove", { cartId: cart.id, lineIds: removals }, identity.buyerIp);
      cart = result.cart ?? cart;
      userErrors = [...userErrors, ...result.userErrors];
      warnings = [...warnings, ...result.warnings];
    }
    return { status: 200, body: { cart: present(cart, false), userErrors, warnings } };
  }
  if (operation.op === "note") {
    if (typeof operation.note !== "string" || operation.note.length > 5000) return { status: 400, body: empty("The note is too long.") };
    const result = await deps.shopify.mutate("note", { cartId: ready.cart.id, note: operation.note }, identity.buyerIp);
    return { status: 200, body: { cart: present(result.cart ?? ready.cart, false), userErrors: result.userErrors, warnings: result.warnings } };
  }
  if (operation.op === "discount-modify") {
    const code = typeof operation.code === "string" ? operation.code : null;
    if ((operation.mode !== "apply" && operation.mode !== "remove") || !code) {
      return { status: 400, body: empty("A discount code is invalid.") };
    }
    const codes = ready.cart.discountCodes.map((discount) => discount.code);
    const discountCodes = operation.mode === "apply" ? [...codes, code] : codes.filter((existing) => existing.toLowerCase() !== code.toLowerCase());
    const result = await deps.shopify.mutate("discount", { cartId: ready.cart.id, discountCodes }, identity.buyerIp);
    return { status: 200, body: { cart: present(result.cart ?? ready.cart, false), userErrors: result.userErrors, warnings: result.warnings } };
  }
  if (operation.op === "discount") {
    if (!Array.isArray(operation.discountCodes) || operation.discountCodes.some((code) => typeof code !== "string")) {
      return { status: 400, body: empty("A discount code is invalid.") };
    }
    const result = await deps.shopify.mutate("discount", { cartId: ready.cart.id, discountCodes: operation.discountCodes }, identity.buyerIp);
    return { status: 200, body: { cart: present(result.cart ?? ready.cart, false), userErrors: result.userErrors, warnings: result.warnings } };
  }
  const attributes = parseAttributes(operation.attributes);
  if (!attributes) return { status: 400, body: empty("Cart attributes are invalid.") };
  const result = await deps.shopify.mutate("attributes", { cartId: ready.cart.id, attributes }, identity.buyerIp);
  return { status: 200, body: { cart: present(result.cart ?? ready.cart, false), userErrors: result.userErrors, warnings: result.warnings } };
}

export function parseCartOperation(body: unknown): CartOp | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const op = record.op;
  if (op === "get") return { op };
  if (op === "add") return { op, lines: record.lines };
  if (op === "update") return { op, lines: record.lines };
  if (op === "remove") return { op, lineIds: record.lineIds };
  if (op === "note") return { op, note: record.note };
  if (op === "discount") return { op, discountCodes: record.discountCodes };
  if (op === "discount-modify") return { op, mode: record.mode, code: record.code };
  if (op === "attributes") return { op, attributes: record.attributes };
  if (op === "merge") return { op, sourceCartId: record.sourceCartId, lines: record.lines };
  if (op === "checkout") return { op };
  return null;
}

const CUSTOMER_ID_QUERY = gql(`query SharedCartCustomer { customer { id } }`);

const METAFIELD_QUERY = gql(`
  query SharedCartMetafield($namespace: String!, $key: String!) {
    customer {
      metafield(namespace: $namespace, key: $key) {
        value
        compareDigest
      }
    }
  }
`);

const METAFIELD_SET = gql(`
  mutation SetSharedCartMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { compareDigest }
      userErrors { message }
    }
  }
`);

export function createCustomerMetafields(
  shopId: string,
  accessToken: string,
  requestContext: ShopifyRequestContext,
  namespace: string,
): AdminMetafields {
  const client = createCustomerAccountClient({ shopId, requestContext });
  return {
    async read(_customerGid, key) {
      const result = await client.graphql(METAFIELD_QUERY, {
        accessToken,
        variables: { namespace, key },
      });
      const metafield = result.data?.customer?.metafield;
      return { value: metafield?.value ?? null, compareDigest: metafield?.compareDigest ?? null };
    },
    async compareAndSet(customerGid, key, value, compareDigest) {
      const result = await client.graphql(METAFIELD_SET, {
        accessToken,
        variables: {
          metafields: [{
            ownerId: customerGid,
            namespace,
            key,
            type: CART_METAFIELD.type,
            value,
            compareDigest,
          }],
        },
      });
      const payload = result.data?.metafieldsSet;
      const message = payload?.userErrors?.[0]?.message ?? result.errors?.[0]?.message;
      if (!payload || (payload.userErrors?.length ?? 0) > 0 || result.errors?.length) {
        return { ok: false, message: message || "The shared cart could not be saved." };
      }
      return { ok: true, compareDigest: payload.metafields?.[0]?.compareDigest ?? "" };
    },
  };
}

export async function fetchCustomerGid(
  shopId: string,
  accessToken: string,
  requestContext: ShopifyRequestContext,
): Promise<string | null> {
  try {
    const client = createCustomerAccountClient({ shopId, requestContext });
    const result = await client.graphql(CUSTOMER_ID_QUERY, { accessToken });
    const id = result.data?.customer?.id;
    return typeof id === "string" && isCustomerGid(id) ? id : null;
  } catch (error) {
    if (error instanceof CustomerAccountApiError) return null;
    throw error;
  }
}

type ProxyEnv = SharedCartEnv & {
  APP_PROXY_SECRET?: string;
};

function buyerIp(request: Request): string | null {
  return request.headers.get("oxygen-buyer-ip")?.trim()
    || request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || null;
}

export async function handleAppProxyCart(
  request: Request,
  env: ProxyEnv,
  hooks?: { now?: number; deps?: Deps },
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 403 });
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/cart")) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  const proxy = await verifyProxySignature(url, env.APP_PROXY_SECRET ?? "", hooks?.now ?? Math.floor(Date.now() / 1000));
  if (!proxy || proxy.shop !== SHOP_DOMAIN) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "private, no-store" } });
  }
  const customerGid = customerGidFromProxy(proxy.customerId);
  if (!customerGid) {
    return Response.json(
      { cart: null, userErrors: [{ message: "Sign in to use the combined cart." }], warnings: [] },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
  const ip = buyerIp(request);
  if (!ip) return Response.json({ error: "Missing buyer address" }, { status: 400, headers: { "cache-control": "private, no-store" } });
  let operation: CartOp = { op: "get" };
  if (request.method === "POST") {
    let parsed: CartOp | null;
    try {
      parsed = parseCartOperation(await request.json());
    } catch {
      return Response.json({ error: "Invalid cart request" }, { status: 400, headers: { "cache-control": "private, no-store" } });
    }
    if (!parsed) {
      return Response.json({ error: "Invalid cart request" }, { status: 400, headers: { "cache-control": "private, no-store" } });
    }
    operation = parsed;
  } else if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { "cache-control": "private, no-store" } });
  }
  const clients = hooks?.deps ? null : createSharedCartClients(env);
  const deps = hooks?.deps ?? (clients && env.SHOPIFY_CLIENT_SECRET ? { ...clients, pepper: env.SHOPIFY_CLIENT_SECRET } : null);
  if (!deps) {
    return Response.json({ error: "Shared cart is not configured." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
  let result: Awaited<ReturnType<typeof handleSharedCart>>;
  try {
    result = await handleSharedCart(deps, { shop: SHOP_DOMAIN, customerGid, accessToken: null, buyerIp: ip }, operation);
  } catch {
    return Response.json({ error: "Shared cart is not available." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "private, no-store" } });
}

export const SHARED_CART_VENDORS = APPROVED_VENDORS;
