const REFRESH_BEFORE_MS = 60_000;

export class AdminTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminTokenError";
  }
}

export type AdminCredentialEnv = {
  PUBLIC_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
};

type CachedToken = { token: string; expiresAt: number };

type TokenResponse = {
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
};

type ScopeResponse = {
  access_scopes?: { handle?: unknown }[];
};

export function createAdminTokenClient(fetchImpl: typeof fetch, now: () => number = () => Date.now()) {
  const cache = new Map<string, CachedToken>();
  const pending = new Map<string, Promise<string>>();

  function cacheKey(env: AdminCredentialEnv): string | null {
    const shop = env.PUBLIC_STORE_DOMAIN;
    const clientId = env.SHOPIFY_CLIENT_ID;
    if (!shop || !clientId || !env.SHOPIFY_CLIENT_SECRET) return null;
    return `${shop}\n${clientId}`;
  }

  function invalidate(env: AdminCredentialEnv) {
    const key = cacheKey(env);
    if (key) cache.delete(key);
  }

  async function exchange(env: AdminCredentialEnv, key: string): Promise<string> {
    const shop = env.PUBLIC_STORE_DOMAIN!;
    const clientId = env.SHOPIFY_CLIENT_ID!;
    const clientSecret = env.SHOPIFY_CLIENT_SECRET!;
    const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!response.ok) throw new AdminTokenError("Admin API token request failed.");
    const payload = (await response.json()) as TokenResponse;
    const token = typeof payload.access_token === "string" ? payload.access_token : "";
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 0;
    if (!token || expiresIn <= 0) throw new AdminTokenError("Admin API token request failed.");
    const granted = await grantedScopes(shop, token);
    const declared = typeof payload.scope === "string" ? payload.scope.split(",").map((scope) => scope.trim()) : [];
    if (!granted.includes("write_customers") || (declared.length > 0 && !declared.includes("write_customers"))) {
      throw new AdminTokenError("write_customers is not granted.");
    }
    cache.set(key, { token, expiresAt: now() + expiresIn * 1000 });
    return token;
  }

  async function grantedScopes(shop: string, token: string): Promise<string[]> {
    const response = await fetchImpl(`https://${shop}/admin/oauth/access_scopes.json`, {
      headers: { accept: "application/json", "X-Shopify-Access-Token": token },
    });
    if (!response.ok) throw new AdminTokenError("Admin API token request failed.");
    const payload = (await response.json()) as ScopeResponse;
    return (payload.access_scopes ?? []).flatMap((scope) => typeof scope.handle === "string" ? [scope.handle] : []);
  }

  async function getAccessToken(env: AdminCredentialEnv): Promise<string> {
    const key = cacheKey(env);
    if (!key) throw new AdminTokenError("Admin API credentials are not configured.");
    const cached = cache.get(key);
    if (cached && cached.expiresAt - now() > REFRESH_BEFORE_MS) return cached.token;
    const current = pending.get(key);
    if (current) return current;
    const request = exchange(env, key).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  return { getAccessToken, invalidate };
}

const adminTokens = createAdminTokenClient(fetch);

export function getAdminAccessToken(env: AdminCredentialEnv): Promise<string> {
  return adminTokens.getAccessToken(env);
}

export function invalidateAdminAccessToken(env: AdminCredentialEnv) {
  adminTokens.invalidate(env);
}
