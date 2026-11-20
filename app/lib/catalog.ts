import { isApprovedVendor } from "@loreal/shared-cart";

export const HOME_COLLECTION_HANDLES = ["la-roche-posay", "kerastase"] as const;

export const HOME_VENDOR_QUERY = 'vendor:"La Roche-Posay" OR vendor:"Kérastase"';

export function isHomeCollection(handle: string | undefined): boolean {
  return HOME_COLLECTION_HANDLES.some((allowed) => allowed === handle);
}

export function isHomeVendor(vendor: string | null | undefined): boolean {
  return isApprovedVendor(vendor);
}
