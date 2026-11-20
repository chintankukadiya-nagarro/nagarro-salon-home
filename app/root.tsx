import { handleShopifyRedirects, handleShopifyRoutes } from "@shopify/hydrogen";
import { ShopifyScripts } from "@shopify/hydrogen/react";
import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
  useRouteLoaderData,
} from "react-router";

import { CartAnalyticsTracker, PageViewedTracker } from "~/components/AnalyticsTrackers";
import { BrandBar } from "~/components/BrandBar";
import { AnnouncementBar } from "~/components/AnnouncementBar";
import { CartDrawer } from "~/components/CartDrawer";
import { CartFocusRefresh } from "~/components/CartFocusRefresh";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";
import { SearchDrawer } from "~/components/SearchDrawer";
import { CartProvider } from "~/lib/cart";
import { loadSharedCart, sharedCartHandlers } from "~/lib/cart-handlers";
import { createRequestCustomerAccount, customerAccountContext, getCustomerSession } from "~/lib/customer-account";
import { brandBarLinks } from "~/lib/brand-bar";
import { envContext } from "~/lib/env";
import { predictiveSearchHandlers } from "~/lib/predictive-search-handlers";
import { loadRootLayout } from "~/lib/root-layout";
import { routeTemplates } from "~/lib/route-templates";
import { createEphemeralSessionManager } from "~/lib/session";
import {
  EXPIRED_CART_COOKIE,
  readCustomerAccessToken,
  setCustomerSessionReader,
  setSharedCartEnv,
  sharedCheckoutRedirect,
} from "@loreal/shared-cart";
import { analyticsConsent, resolveShopIdentity, storefrontConfig } from "~/lib/shop";
import {
  createRequestStorefrontClient,
  storefrontClientContext,
  storefrontRequestContext,
} from "~/lib/storefront";

import type { Route } from "./+types/root";

import appStylesHref from "./app.css?url";

setCustomerSessionReader(getCustomerSession);

export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: appStylesHref },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export const middleware: Route.MiddlewareFunction[] = [
  async ({ context, request }, next) => {
    const env = context.get(envContext);
    const storefrontClient = createRequestStorefrontClient(
      request,
      env,
      context.cache,
      context.waitUntil,
    );
    const requestContext = storefrontClient.requestContext;
    const customerAccount = await createRequestCustomerAccount(request, env, requestContext);
    const sessionManager =
      customerAccount?.customerAccount.sessionManager ?? createEphemeralSessionManager(request);
    setSharedCartEnv(env);
    const pathname = new URL(request.url).pathname;
    if (customerAccount && (pathname === "/checkout" || pathname === "/api/shared-checkout")) {
      const accessToken = await readCustomerAccessToken({
        request,
        sessionManager: customerAccount.customerAccount.sessionManager,
        requestContext,
      });
      const checkout = await sharedCheckoutRedirect(request, accessToken, requestContext);
      if (checkout) {
        const sessionHeaders = new Headers(
          (await customerAccount.customerAccount.sessionManager.commit?.()) ?? undefined,
        );
        for (const [name, value] of sessionHeaders) checkout.headers.append(name, value);
        return checkout;
      }
    }

    const shopifyRoute = await handleShopifyRoutes({
      request,
      requestContext,
      sessionManager,
      storefrontClient,
      routeTemplates,
      handlers: customerAccount
        ? [sharedCartHandlers, predictiveSearchHandlers, customerAccount.handlers]
        : [sharedCartHandlers, predictiveSearchHandlers],
    });

    if (shopifyRoute) {
      if (new URL(request.url).pathname === "/account/logout") {
        shopifyRoute.headers.append("set-cookie", EXPIRED_CART_COOKIE);
      }
      return shopifyRoute;
    }

    context.set(storefrontClientContext, storefrontClient);
    context.set(storefrontRequestContext, requestContext);
    context.set(customerAccountContext, customerAccount?.customerAccount ?? null);

    const response = await next();
    const sessionHeaders = new Headers((await sessionManager.commit?.()) ?? undefined);
    for (const [name, value] of sessionHeaders) response.headers.append(name, value);
    if (response.status === 404) {
      const redirect = await handleShopifyRedirects({
        request,
        storefrontClient,
        routeTemplates,
      });

      if (redirect) return redirect;
    }

    requestContext.applyResponseHeaders(response.headers);
    return response;
  },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  const env = context.get(envContext);
  const storefrontClient = context.get(storefrontClientContext);
  const customerAccount = context.get(customerAccountContext);
  const requestContext = context.get(storefrontRequestContext);
  const sessionManager = customerAccount?.sessionManager ?? createEphemeralSessionManager(request);
  const [cartLoaded, layout] = await Promise.all([
    loadSharedCart({ storefrontClient, request, sessionManager, requestContext }),
    loadRootLayout(storefrontClient),
  ]);

  return {
    cartData: cartLoaded.result.data,
    shopInfo: layout.shopInfo,
    shopIdentity: resolveShopIdentity(env, layout.shopId),
    currency: layout.currency,
    brandBar: brandBarLinks(env),
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // Absent when the root loader failed (error page only).
  const rootData = useRouteLoaderData<typeof loader>("root");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {rootData ? (
          <ShopifyScripts
            i18n={{ ...storefrontConfig.i18n, currency: rootData.currency }}
            shop={rootData.shopIdentity.scriptShop}
            analytics={{ channel: rootData.shopIdentity.analyticsShop.channel }}
            shopifyAnalytics={rootData.shopIdentity.shopifyAnalytics}
            consent={analyticsConsent}
            navigate={navigate}
            routes={routeTemplates}
          />
        ) : null}
        <Meta />
        <Links />
      </head>
      <body className="bg-surface text-on-surface font-body flex min-h-svh flex-col antialiased">
        <a
          href="#main-content"
          className="focus-visible:bg-interactive focus-visible:text-interactive-text sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:start-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded focus-visible:px-4 focus-visible:py-2"
        >
          Skip to content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <CartProvider initialData={loaderData.cartData}>
      <PageViewedTracker />
      <CartAnalyticsTracker />
      <CartFocusRefresh />
      <div className="sticky top-0 z-40">
        <BrandBar links={loaderData.brandBar} />
        <AnnouncementBar />
        <Header shopInfo={loaderData.shopInfo} />
      </div>
      <Outlet />
      <Footer shopInfo={loaderData.shopInfo} />
      <CartDrawer />
      <SearchDrawer />
    </CartProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  const rootData = useRouteLoaderData<typeof loader>("root");

  return (
    <>
    <div className="sticky top-0 z-40">
      <BrandBar links={rootData?.brandBar ?? brandBarLinks()} />
    </div>
    <main
      id="main-content"
      tabIndex={-1}
      className="max-w-page px-margin mx-auto w-full flex-1 py-12"
    >
      <h1 className="type-display text-on-surface">{message}</h1>
      <p className="text-on-surface-secondary mt-4">{details}</p>
      {stack ? (
        <pre className="border-border mt-6 w-full overflow-x-auto rounded border p-4 text-sm">
          <code>{stack}</code>
        </pre>
      ) : null}
    </main>
    </>
  );
}
