/**
 * The `<YatrisForm>` browser renderer (`@yatris/astro/forms/client`).
 *
 * The component writes a mount element with a JSON configuration; this
 * module finds those mounts, loads each published definition from Yatris and
 * renders it. Vanilla TypeScript, no framework, no global styles.
 *
 * Reference: contracts/forms/v1/README.md §8 in this package.
 */

import { FormController, type MountOptions } from './controller.js';
import type { MountConfig, PreviewModule } from './types.js';

export { SUPPORTED_CAPABILITIES, SUPPORTED_CONTRACT_VERSIONS, missingCapabilities } from './capabilities.js';
export { FormController, newIdempotencyKey, rejectionCode, retryAfterSeconds, type MountOptions } from './controller.js';
export { TURNSTILE_SCRIPT, type TurnstileApi } from './turnstile.js';
export { CLASS_SLOTS, type ClassSlot, type MountConfig, type PreviewHooks, type PreviewModule } from './types.js';

export function mountForm(root: HTMLElement, config: MountConfig, options: MountOptions = {}): FormController {
  return new FormController(root, config, options);
}

/** Reads the configuration `<YatrisForm>` wrote into a mount element. */
export function readMountConfig(root: HTMLElement): MountConfig {
  const text = root.querySelector('script[data-yf-config]')?.textContent ?? '';
  try {
    const config = JSON.parse(text) as MountConfig;
    if (config && (config.mode === 'live' || config.mode === 'preview' || config.mode === 'unconfigured')) return config;
  } catch {
    // fall through
  }
  return { mode: 'unconfigured', form: root.getAttribute('data-yatris-form') ?? '', timeZone: 'Asia/Tokyo', reason: 'the mount has no readable configuration' };
}

/**
 * Mounts every `<YatrisForm>` on the page that is not mounted yet. `preview`
 * is the dev-only preview module; it is null in every production build, and a
 * preview mount without it shows the unavailable state (never a fake form).
 */
export function mountAll(preview: PreviewModule | null = null, options: MountOptions = {}): FormController[] {
  const controllers: FormController[] = [];
  for (const root of Array.from(document.querySelectorAll<HTMLElement>('[data-yatris-form]:not([data-yf-mounted])'))) {
    const config = readMountConfig(root);
    if (config.mode === 'preview') {
      if (!preview) {
        controllers.push(mountForm(root, { mode: 'unconfigured', form: config.form, timeZone: config.timeZone, reason: 'preview mounts need astro dev with YATRIS_FORMS_PREVIEW=1' }, options));
        continue;
      }
      const hooks = preview.createPreview(config);
      controllers.push(mountForm(root, config, { ...options, fetch: hooks.fetch, decorate: hooks.decorate }));
      continue;
    }
    controllers.push(mountForm(root, config, options));
  }
  return controllers;
}
