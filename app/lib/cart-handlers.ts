import { createCartServerHandlers, createShopifyRouteHandler, type StorefrontClient } from "@shopify/hydrogen";
import type { ShopifyRequestContext } from "@shopify/hydrogen";
import type { WritableCustomerSessionManager } from "@shopify/hydrogen/customer-account";

import {
  actionToOperation,
  callSharedCart,
  mergeAnonymousCart,
  EMPTY_SHARED_CART,
  presentSharedCart,
  readCartAction,
  readCustomerAccessToken,
  sameOrigin,
  sharedCartConfigured,
  type SharedCartResponse,
} from "@loreal/shared-cart";

const baseCartHandlers = createCartServerHandlers();

export const cartHandlers = baseCartHandlers;

type CartContext = {
  request: Request;
  storefrontClient: StorefrontClient;
  sessionManager: WritableCustomerSessionManager;
  requestContext: ShopifyRequestContext;
};

function privateHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("cache-control", "private, no-store");
  return headers;
}

function messages(body: SharedCartResponse): { message: string }[] {
  return [
    ...(body.userErrors ?? []),
    ...(body.error ? [{ message: body.error }] : []),
  ];
}

async function signedInCart(context: CartContext, body: Record<string, unknown>) {
  const { request } = context;
  const headers = privateHeaders();
  if (request.method === "POST" && !sameOrigin(request)) {
    return {
      type: "error" as const,
      status: 403,
      error: { code: "forbidden", message: "Forbidden" },
      headers,
    };
  }
  const accessToken = await readCustomerAccessToken(context);
  if (!accessToken) return null;
  if (!sharedCartConfigured()) {
    return {
      type: "json" as const,
      headers,
      notices: ["Shared cart is not configured."],
      data: {
        cart: EMPTY_SHARED_CART,
        userErrors: [{ message: "Shared cart is not configured." }],
        warnings: [],
      } as unknown as Awaited<ReturnType<typeof baseCartHandlers.get>>["data"],
    };
  }

  const merged = await mergeAnonymousCart(request, context.storefrontClient, accessToken, context.requestContext);
  if (merged.cookie) headers.append("set-cookie", merged.cookie);
  const sessionHeaders = await context.sessionManager.commit?.();
  if (sessionHeaders) {
    for (const cookie of new Headers(sessionHeaders).getSetCookie()) headers.append("set-cookie", cookie);
  }

  const result = await callSharedCart(request, accessToken, body, context.requestContext);
  const cart = presentSharedCart(result.body.cart) ?? EMPTY_SHARED_CART;
  const isForm = !request.headers.get("content-type")?.includes("application/json");
  if (isForm && request.method === "POST") {
    return { type: "redirect" as const, location: sameOriginPath(request), headers };
  }
  const userErrors = [...messages(result.body), ...merged.userErrors];
  return {
    type: "json" as const,
    headers,
    notices: userErrors.map((error) => error.message),
    data: {
      cart,
      userErrors,
      warnings: [...(result.body.warnings ?? []), ...merged.warnings],
    } as unknown as Awaited<ReturnType<typeof baseCartHandlers.get>>["data"],
  };
}

function sameOriginPath(request: Request): string {
  const referer = request.headers.get("referer");
  if (!referer) return "/cart";
  try {
    const target = new URL(referer);
    if (target.origin !== new URL(request.url).origin) return "/cart";
    return `${target.pathname}${target.search}` || "/cart";
  } catch {
    return "/cart";
  }
}

export async function loadSharedCart(context: CartContext) {
  const signedIn = await signedInCart(context, { op: "get" });
  if (signedIn && signedIn.type === "json") {
    return { result: { type: signedIn.type, headers: signedIn.headers, data: signedIn.data }, notices: signedIn.notices };
  }
  const result = await baseCartHandlers.get(context);
  return { result, notices: [] as string[] };
}

export const sharedCartHandlers = {
  get: createShopifyRouteHandler("/api/cart", "GET", async (context: CartContext) => {
    const loaded = await loadSharedCart(context);
    return loaded.result;
  }),
  post: createShopifyRouteHandler("/api/cart", "POST", async (context: CartContext) => {
    const cartRequest = context.request.clone();
    const parsed = await readCartAction(cartRequest);
    await cartRequest.arrayBuffer().catch(() => undefined);
    const signedIn = await signedInCart(context, parsed ? actionToOperation(parsed) : { op: "get" });
    if (signedIn) await context.request.arrayBuffer().catch(() => undefined);
    if (signedIn?.type === "json") {
      return { type: signedIn.type, headers: signedIn.headers, data: signedIn.data };
    }
    if (signedIn) return signedIn;
    return baseCartHandlers.post(context);
  }),
};
