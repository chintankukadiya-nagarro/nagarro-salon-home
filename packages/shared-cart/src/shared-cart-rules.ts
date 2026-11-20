export const SHOP_DOMAIN = "nagarro-salon-pro.myshopify.com";
export const PUBLIC_CART_ID = "gid://shopify/Cart/shared";
export const COUNTRY = "IN";
export const APPROVED_VENDORS = ["La Roche-Posay", "Kérastase"] as const;

/**
 * A private Oxygen environment blocks Shopify's app proxy.
 * The proxy does not send a staff session or oxygen-auth-bypass-token.
 */
export const OXYGEN_PRIVATE_BLOCKS_APP_PROXY = true;

export const CART_METAFIELD = {
  ownerType: "CUSTOMER",
  namespace: "$app",
  cartKey: "cart_id",
  mergesKey: "merges",
  type: "single_line_text_field",
  access: {
    admin: "merchant_read",
    storefront: "none",
    customerAccount: "read_write",
  },
} as const;

const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const LINE_ID = /^gid:\/\/shopify\/CartLine\/[A-Za-z0-9_-]+$/;
const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/\d+$/;
const MAX_SKEW_SECONDS = 90;

export function isApprovedVendor(vendor: string | null | undefined): boolean {
  return vendor === "La Roche-Posay" || vendor === "Kérastase";
}

export function customerGidFromProxy(id: string | null): string | null {
  if (!id || !/^\d+$/.test(id)) return null;
  return `gid://shopify/Customer/${id}`;
}

export function isCustomerGid(id: string): boolean {
  return CUSTOMER_GID.test(id);
}

export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 250) return null;
  return value;
}

export function parseMerchandiseId(value: unknown): string | null {
  return typeof value === "string" && VARIANT_ID.test(value) ? value : null;
}

export function parseLineId(value: unknown): string | null {
  return typeof value === "string" && LINE_ID.test(value) ? value : null;
}

export function parseAttributes(value: unknown): { key: string; value: string }[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const attributes = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const key = "key" in entry ? entry.key : undefined;
    const attributeValue = "value" in entry ? entry.value : undefined;
    if (typeof key !== "string" || typeof attributeValue !== "string") return null;
    if (key.length === 0 || key.length > 100 || attributeValue.length > 500) return null;
    attributes.push({ key, value: attributeValue });
  }
  return attributes;
}

export type CartLineInput = {
  merchandiseId: string;
  quantity: number;
  sellingPlanId?: string;
  attributes?: { key: string; value: string }[];
};

export type ExistingLine = {
  merchandiseId: string;
  quantity: number;
  sellingPlanId?: string;
  attributes?: { key: string; value?: string | null }[];
};

export function lineSignature(line: ExistingLine): string {
  const attributes = [...(line.attributes ?? [])]
    .map((attribute) => `${attribute.key}=${attribute.value ?? ""}`)
    .sort();
  return `${line.merchandiseId}|${line.sellingPlanId ?? ""}|${attributes.join("&")}`;
}

export function linesToMerge(source: readonly CartLineInput[], existing: readonly ExistingLine[], retry: boolean): CartLineInput[] {
  if (!retry) return source.map((line) => ({ ...line }));
  const quantities = new Map<string, number>();
  for (const line of existing) {
    const key = lineSignature(line);
    quantities.set(key, (quantities.get(key) ?? 0) + line.quantity);
  }
  return source.flatMap((line) => {
    const present = quantities.get(lineSignature(line)) ?? 0;
    if (present >= line.quantity) return [];
    return [{ ...line, quantity: line.quantity - present }];
  });
}

export function rejectedMerchandise(
  ids: readonly string[],
  nodes: readonly ({ __typename?: string; id?: string; product?: { title?: string | null; vendor?: string | null } | null } | null)[],
): { id: string; title: string }[] {
  const byId = new Map(nodes.filter((node) => node?.id).map((node) => [node!.id!, node]));
  return ids.flatMap((id) => {
    const node = byId.get(id);
    if (node?.__typename === "ProductVariant" && isApprovedVendor(node.product?.vendor)) return [];
    return [{ id, title: node?.product?.title?.trim() || "This product" }];
  });
}

export async function hashSourceCart(sourceCartId: string, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${pepper}:${sourceCartId}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function proxyMessage(params: URLSearchParams): string | null {
  const groups = new Map<string, string[]>();
  for (const [key, value] of params.entries()) {
    if (key === "signature") continue;
    const values = groups.get(key) ?? [];
    values.push(value);
    groups.set(key, values);
  }
  for (const key of ["shop", "timestamp", "logged_in_customer_id", "path_prefix"]) {
    if (params.getAll(key).length > 1) return null;
  }
  if (params.getAll("signature").length !== 1) return null;
  return [...groups.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");
}

export async function signProxy(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function verifyProxySignature(
  url: URL,
  secret: string,
  nowSeconds: number,
): Promise<{ shop: string; customerId: string | null } | null> {
  if (!secret) return null;
  const signature = url.searchParams.get("signature");
  const message = proxyMessage(url.searchParams);
  if (!signature || !message) return null;
  const expected = await signProxy(message, secret);
  if (!safeEqual(signature, expected)) return null;
  const timestamp = Number(url.searchParams.get("timestamp"));
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) return null;
  const shop = url.searchParams.get("shop");
  if (!shop) return null;
  return { shop, customerId: url.searchParams.get("logged_in_customer_id") || null };
}

export type MergeReceipt = { hash: string; status: "open" | "done" };

export function parseMerges(value: string | null): MergeReceipt[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const hash = "hash" in entry ? entry.hash : undefined;
      const status = "status" in entry ? entry.status : undefined;
      if (typeof hash !== "string" || (status !== "open" && status !== "done")) return [];
      return [{ hash, status }];
    });
  } catch {
    return [];
  }
}
