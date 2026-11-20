export type BrandId = "la-roche-posay" | "kerastase";

export const CURRENT_BRAND: BrandId | null = null;

export const LA_ROCHE_POSAY_COLOR = "#0057b8";
export const KERASTASE_COLOR = "#5d0707";

const LOCAL_LA_ROCHE_POSAY_URL = "https://local.tryhydrogen.dev:5173";
const LOCAL_KERASTASE_URL = "https://127.0.0.1:5174";

export type BrandBarLinks = {
  laRochePosay: string;
  kerastase: string;
};

type BrandBarEnv = {
  PUBLIC_LA_ROCHE_POSAY_URL?: string;
  PUBLIC_KERASTASE_URL?: string;
};

export function brandBarLinks(env?: BrandBarEnv): BrandBarLinks {
  return {
    laRochePosay: storefrontOrigin(env?.PUBLIC_LA_ROCHE_POSAY_URL, LOCAL_LA_ROCHE_POSAY_URL),
    kerastase: storefrontOrigin(env?.PUBLIC_KERASTASE_URL, LOCAL_KERASTASE_URL),
  };
}

function storefrontOrigin(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}
