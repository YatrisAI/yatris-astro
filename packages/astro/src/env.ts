import { fileURLToPath } from 'node:url';

export const DELIVERY_ENV = ['YATRIS_DELIVERY_ENDPOINT', 'YATRIS_DELIVERY_API_KEY'] as const;

/**
 * Makes the Delivery settings from the site's ignored `.env` files visible to
 * build-time code through `process.env`, the way deployment secret stores
 * provide them. Real environment variables always win.
 */
export async function loadDeliveryEnv(root: URL, mode: string): Promise<void> {
  if (DELIVERY_ENV.every((name) => process.env[name] !== undefined)) return;
  let loadEnv: (mode: string, dir: string, prefix: string) => Record<string, string>;
  try {
    ({ loadEnv } = (await import('vite' as string)) as { loadEnv: typeof loadEnv });
  } catch {
    return;
  }
  const env = loadEnv(mode, fileURLToPath(root), 'YATRIS_');
  for (const name of DELIVERY_ENV) {
    if (process.env[name] === undefined && env[name]) process.env[name] = env[name];
  }
}
