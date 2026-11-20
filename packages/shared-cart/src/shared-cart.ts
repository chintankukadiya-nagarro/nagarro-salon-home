import {
  getCart,
  getCartId,
  parseCartRequest,
  type CartAction,
  type StorefrontClient,
} from "@shopify/hydrogen";
import type { ShopifyRequestContext } from "@shopify/hydrogen";
import type { WritableCustomerSessionManager } from "@shopify/hydrogen/customer-account";

import { AdminTokenError } from "./shared-cart-admin";
import { PUBLIC_CART_ID, SHOP_DOMAIN } from "./shared-cart-rules";
import { createCustomerMetafields, fetchCustomerGid, handleSharedCart, parseCartOperation } from "./shared-cart-service";
import { createSharedCartClients, customerMetafieldNamespace, type SharedCartEnv } from "./shared-cart-shopify";

const DEVELOPMENT_BUYER_IP = "127.0.0.1";
const BUYER_IP_HEADERS = ["oxygen-buyer-ip", "cf-connecting-ip", "x-forwarded-for"] as const;

type SessionReader = {
  getOrRefreshAccessToken(
    sessionManager: WritableCustomerSessionManager,
    requestContext: ShopifyRequestContext,
  ): Promise<string | undefined>;
};

let customerSessionReader: () => SessionReader | null = () => null;

export function setCustomerSessionReader(reader: () => SessionReader | null) {
  customerSessionReader = reader;
}

function buyerIp(request: Request): string {
  for (const header of BUYER_IP_HEADERS) {
    const ip = request.headers.get(header)?.split(",")[0]?.trim();
    if (ip) return ip;
  }
  const host = new URL(request.url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "local.tryhydrogen.dev" || host.endsWith(".local.tryhydrogen.dev");
  if (local || process.env.NODE_ENV !== "production") return DEVELOPMENT_BUYER_IP;
  throw new Error("A buyer IP is required.");
}

function safeSharedCartError(error: unknown): string {
  if (error instanceof AdminTokenError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (!message || message.length > 180 || /shcat_|shcrt_|shcac_|eyJ|Bearer /i.test(message)) {
    return "Shared cart is not available.";
  }
  return message;
}

export const EXPIRED_CART_COOKIE = "cart=; Path=/; SameSite=Lax; Max-Age=0";

let runtimeEnv: SharedCartEnv | undefined;

export function setSharedCartEnv(env: SharedCartEnv) {
  runtimeEnv = env;
}

export function isSharedCartId(id: string | null | undefined): boolean {
  return id === PUBLIC_CART_ID;
}

export function sharedCartConfigured(env: SharedCartEnv | undefined = runtimeEnv): boolean {
  return Boolean(
    env?.PUBLIC_STORE_DOMAIN === SHOP_DOMAIN
    && env.SHOP_ID
    && env.SHOPIFY_CLIENT_ID
    && env.SHOPIFY_CLIENT_SECRET
    && (env.SHARED_CART_STOREFRONT_TOKEN || env.PRIVATE_STOREFRONT_API_TOKEN),
  );
}

type SessionContext = {
  request: Request;
  sessionManager: WritableCustomerSessionManager;
  requestContext: ShopifyRequestContext;
};

export async function readCustomerAccessToken(context: SessionContext): Promise<string | undefined> {
  const session = customerSessionReader();
  if (!session) return undefined;
  return session.getOrRefreshAccessToken(context.sessionManager, context.requestContext);
}

export type SharedCartResponse = {
  cart: { id?: string; checkoutUrl?: string | null; lines?: { nodes: unknown[] } } | null;
  userErrors?: { message: string }[];
  warnings?: { message: string }[];
  error?: string;
};

export async function callSharedCart(
  request: Request,
  accessToken: string,
  body: Record<string, unknown>,
  requestContext: ShopifyRequestContext,
  env: SharedCartEnv | undefined = runtimeEnv,
): Promise<{ ok: boolean; status: number; body: SharedCartResponse }> {
  if (!env || !sharedCartConfigured(env)) {
    return { ok: false, status: 503, body: { cart: null, error: "Shared cart is not configured." } };
  }
  const customerGid = await fetchCustomerGid(env.SHOP_ID!, accessToken, requestContext);
  if (!customerGid) {
    return { ok: false, status: 401, body: { cart: null, error: "Sign in to use the combined cart." } };
  }
  const operation = parseCartOperation(body);
  if (!operation) {
    return { ok: false, status: 400, body: { cart: null, error: "Invalid cart request" } };
  }
  const clients = createSharedCartClients(env);
  if (!clients) {
    return { ok: false, status: 503, body: { cart: null, error: "Shared cart is not configured." } };
  }
  try {
    const result = await handleSharedCart(
      { admin: createCustomerMetafields(env.SHOP_ID!, accessToken, requestContext, await customerMetafieldNamespace(env)), shopify: clients.shopify, pepper: env.SHOPIFY_CLIENT_SECRET! },
      { shop: SHOP_DOMAIN, customerGid, accessToken, buyerIp: buyerIp(request) },
      operation,
    );
    return {
      ok: result.status < 400,
      status: result.status,
      body: "cart" in result.body ? result.body : { cart: null, error: result.body.error },
    };
  } catch (error) {
    const message = safeSharedCartError(error);
    const raw = error instanceof Error ? error.message : "";
    const redacted = raw.replace(/shcat_\S+|shcrt_\S+|shcac_\S+|eyJ[\w.-]+/gi, "[redacted]").slice(0, 180);
    console.error(`Shared cart failed: ${error instanceof Error ? error.name : "Error"}: ${redacted}`);
    return { ok: false, status: 503, body: { cart: null, error: message } };
  }
}

export const EMPTY_SHARED_CART = {
  id: PUBLIC_CART_ID,
  updatedAt: "1970-01-01T00:00:00Z",
  checkoutUrl: null,
  totalQuantity: 0,
  note: "",
  attributes: [] as { key: string; value: string | null }[],
  discountCodes: [] as { applicable: boolean; code: string }[],
  cost: {
    subtotalAmount: { amount: "0.0", currencyCode: "INR" },
    totalAmount: { amount: "0.0", currencyCode: "INR" },
    checkoutChargeAmount: { amount: "0.0", currencyCode: "INR" },
  },
  lines: { nodes: [] as [] },
};

export function presentSharedCart<T extends { id?: string; checkoutUrl?: string | null }>(cart: T | null): T | null {
  if (!cart) return null;
  return { ...cart, id: PUBLIC_CART_ID, checkoutUrl: null };
}

export function actionToOperation(action: CartAction): Record<string, unknown> {
  switch (action.intent) {
    case "add":
      return { op: "add", lines: action.lines };
    case "update":
      return { op: "update", lines: action.lines };
    case "remove":
      return { op: "remove", lineIds: action.lineIds };
    case "discount-update":
      return { op: "discount", discountCodes: action.discountCodes };
    case "discount-apply":
      return { op: "discount-modify", mode: "apply", code: action.code };
    case "discount-remove":
      return { op: "discount-modify", mode: "remove", code: action.code };
    case "note-update":
      return { op: "note", note: action.note };
    case "attributes-update":
      return { op: "attributes", attributes: action.attributes };
  }
}

export async function mergeAnonymousCart(
  request: Request,
  storefrontClient: StorefrontClient,
  accessToken: string,
  requestContext: ShopifyRequestContext,
): Promise<{ cookie: string | null; userErrors: { message: string }[]; warnings: { message: string }[] }> {
  const cartId = getCartId(request);
  if (!cartId) return { cookie: null, userErrors: [], warnings: [] };
  let lines: { merchandiseId: string; quantity: number; sellingPlanId?: string; attributes?: { key: string; value: string }[] }[] = [];
  try {
    const loaded = await getCart(cartId, storefrontClient);
    lines = (loaded.cart?.lines.nodes ?? []).flatMap((line) => {
      const merchandise = line.merchandise;
      if (!merchandise || !("id" in merchandise) || typeof merchandise.id !== "string") return [];
      const sellingPlanId = line.sellingPlanAllocation?.sellingPlan.id;
      return [
        {
          merchandiseId: merchandise.id,
          quantity: line.quantity,
          ...(sellingPlanId ? { sellingPlanId } : {}),
          attributes: (line.attributes ?? []).flatMap((attribute) =>
            attribute.value == null ? [] : [{ key: attribute.key, value: attribute.value }],
          ),
        },
      ];
    });
  } catch {
    return {
      cookie: null,
      userErrors: [{ message: "The previous cart could not be merged. Try again." }],
      warnings: [],
    };
  }
  if (lines.length === 0) return { cookie: EXPIRED_CART_COOKIE, userErrors: [], warnings: [] };
  const result = await callSharedCart(request, accessToken, { op: "merge", sourceCartId: cartId, lines }, requestContext);
  const userErrors = result.body.userErrors ?? [];
  if (!result.ok || userErrors.length > 0) {
    return { cookie: null, userErrors: userErrors.length > 0 ? userErrors : [{ message: result.body.error ?? "The previous cart could not be merged." }], warnings: result.body.warnings ?? [] };
  }
  return { cookie: EXPIRED_CART_COOKIE, userErrors: [], warnings: result.body.warnings ?? [] };
}

export function sameOrigin(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

export async function sharedCheckoutRedirect(
  request: Request,
  accessToken: string | undefined,
  requestContext: ShopifyRequestContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isCheckout = url.pathname === "/checkout" || url.pathname === "/api/shared-checkout";
  if (!isCheckout || !accessToken || !sharedCartConfigured()) return null;
  if (url.pathname === "/api/shared-checkout") {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  }
  const result = await callSharedCart(request, accessToken, { op: "checkout" }, requestContext);
  const checkoutUrl = result.body.cart?.checkoutUrl;
  if (!checkoutUrl) return Response.redirect(new URL("/cart", request.url), 303);
  return Response.redirect(checkoutUrl, 303);
}

export async function readCartAction(request: Request): Promise<CartAction | null> {
  try {
    return (await parseCartRequest(request)).action;
  } catch {
    return null;
  }
}
