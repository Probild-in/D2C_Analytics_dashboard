const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ADMIN_URL_RE = /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#].*)?$/;

// Turns whatever a user pasted (store name, myshopify domain, admin URL) into the canonical
// "<handle>.myshopify.com" form, or null if it isn't recognizably a Shopify store. The result
// is used as the OAuth host, so only the exact canonical shape is ever returned.
export function normalizeShopDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const adminMatch = raw.match(ADMIN_URL_RE);
  if (adminMatch) return `${adminMatch[1]}.myshopify.com`;

  if (HANDLE_RE.test(raw)) return `${raw}.myshopify.com`;

  let host: string;
  try {
    host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  return SHOP_DOMAIN_RE.test(host) ? host : null;
}
