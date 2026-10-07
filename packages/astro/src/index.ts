import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, type YatrisOptions } from './config.js';
import { loadDeliveryEnv } from './env.js';
import { assertFormsMode, declarationFiles, FORMS_DIR, formsEnv, formsRuntime, type FormsRuntime } from './forms-config.js';
import { loadMeasurement, withMeasurement } from './measurement-config.js';
import { missingDestinations, registeredNavigation } from './navigation.js';
import { previewBuild, writePreviewHeaders } from './preview.js';
import { assertReservationsMode, bookingOrigin, RESERVATIONS_DIR, reservationsRuntime, type ReservationsRuntime } from './reservations-config.js';
import { checkSchemaContract } from './schema-check.js';

export type { YatrisOptions } from './config.js';
export type { YatrisPageMeta } from './head.js';
export type { NavigationItem } from './navigation.js';

const VIRTUAL_CONFIG = 'virtual:yatris/config';
const VIRTUAL_FORMS = 'virtual:yatris/forms';
const VIRTUAL_FORMS_PREVIEW = 'virtual:yatris/forms-preview';
const VIRTUAL_RESERVATIONS = 'virtual:yatris/reservations';
const VIRTUAL_RESERVATIONS_PREVIEW = 'virtual:yatris/reservations-preview';

interface Logger {
  warn(message: string): void;
  info(message: string): void;
}

/** The subset of Astro's integration shape this package uses. */
export interface YatrisIntegration {
  name: '@yatris/astro';
  hooks: {
    'astro:config:setup': (options: {
      config?: { root: URL };
      command?: 'dev' | 'build' | 'preview' | 'sync';
      updateConfig: (config: Record<string, unknown>) => unknown;
      logger?: Logger;
    }) => Promise<void>;
    'astro:build:done': (options: { pages: { pathname: string }[]; dir?: URL; logger: Logger }) => void;
  };
}

/**
 * The Yatris Astro integration. It feeds site-level settings to
 * `YatrisHead`/`YatrisBodyStart`, fails a paired production build whose
 * schema lock does not match Yatris, and fails the build when a navigation
 * destination was not built.
 */
export default function yatris(options: YatrisOptions = {}): YatrisIntegration {
  const config = resolveConfig(options);
  // YatrisCMS#310: a yatris-preview build renders drafts, so nothing in it
  // may be indexed or measured (rules in ./preview.ts)
  let preview = false;

  return {
    name: '@yatris/astro',
    hooks: {
      'astro:config:setup': async ({ config: astroConfig, command, updateConfig, logger }) => {
        if (astroConfig) await loadDeliveryEnv(astroConfig.root, command === 'dev' ? 'development' : 'production');
        // YatrisCMS#380: forms load live from Yatris; a local preview exists
        // only under astro dev with YATRIS_FORMS_PREVIEW=1, and a build that
        // asks for it fails here, before anything else runs
        const formsSource = astroConfig
          ? { root: astroConfig.root, command, env: await formsEnv(astroConfig.root, command === 'dev' ? 'development' : 'production') }
          : null;
        const formsPreview = formsSource ? assertFormsMode(command, formsSource.env) : false;
        // YatrisCMS#421: the same rule for reservations, and a bad
        // YATRIS_BOOKING_ORIGIN stops the build here too
        const reservationsPreview = formsSource ? assertReservationsMode(command, formsSource.env) : false;
        if (formsSource) bookingOrigin(formsSource.env);
        // YatrisCMS#304: a paired revisioned site's production build fails
        // unless its schema lock matches the revision Yatris expects
        const schema = astroConfig ? await checkSchemaContract({ root: astroConfig.root, command }) : null;
        if (schema?.schemaMode === 'revisioned') logger?.info(`schema: locked to the ${schema.state} revision ${schema.revision}`);
        // YatrisCMS#271: a paired site's production build takes GTM, Search
        // Console and consent from Yatris
        const measurement = astroConfig ? await loadMeasurement({ root: astroConfig.root, command }) : null;
        const measured = withMeasurement(config, measurement, Boolean(options.gtmContainerId || options.searchConsoleVerification));
        preview = command === 'build' && previewBuild().active;
        const runtime = preview ? { ...measured, gtmContainerId: null, searchConsoleVerification: null, preview: true } : measured;
        const forms: FormsRuntime | null = formsSource && !formsPreview ? await formsRuntime(formsSource) : null;
        if (formsPreview) logger?.info('forms: preview mode — <YatrisForm> shows src/forms/*.json locally and sends nothing');
        if (forms?.mode === 'unconfigured' && command === 'build' && astroConfig && declarationFiles(join(fileURLToPath(astroConfig.root), FORMS_DIR)).length) {
          logger?.warn(`forms: ${forms.reason}; any <YatrisForm> renders its unavailable state`);
        }
        const reservations: ReservationsRuntime | null = formsSource && !reservationsPreview ? reservationsRuntime(formsSource) : null;
        if (reservationsPreview) logger?.info('reservations: preview mode — <ReservationEmbed> shows src/reservations/*.json with synthetic availability and sends nothing');
        if (reservations?.mode === 'unconfigured' && command === 'build' && astroConfig && declarationFiles(join(fileURLToPath(astroConfig.root), RESERVATIONS_DIR)).length) {
          logger?.warn(`reservations: ${reservations.reason}; any <ReservationEmbed> renders its unavailable state`);
        }
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'yatris:config',
                resolveId: (id: string) => (id === VIRTUAL_CONFIG ? `\0${VIRTUAL_CONFIG}` : undefined),
                load: (id: string) => (id === `\0${VIRTUAL_CONFIG}` ? `export default ${JSON.stringify(runtime)};` : undefined),
              },
              {
                name: 'yatris:forms',
                resolveId: (id: string) => (id === VIRTUAL_FORMS || id === VIRTUAL_FORMS_PREVIEW ? `\0${id}` : undefined),
                async load(this: { addWatchFile?: (file: string) => void }, id: string) {
                  if (id === `\0${VIRTUAL_FORMS_PREVIEW}`) {
                    // Production builds get null here, so no preview code is bundled.
                    return formsPreview ? `export { default } from '@yatris/astro/forms/preview';` : 'export default null;';
                  }
                  if (id !== `\0${VIRTUAL_FORMS}`) return undefined;
                  if (formsPreview && formsSource) {
                    // Read the declarations on every load, so edits show up in dev.
                    const dir = join(fileURLToPath(formsSource.root), FORMS_DIR);
                    for (const name of declarationFiles(dir)) this.addWatchFile?.(join(dir, name));
                    return `export default ${JSON.stringify(await formsRuntime(formsSource))};`;
                  }
                  return `export default ${JSON.stringify(forms ?? { mode: 'unconfigured', timeZone: 'Asia/Tokyo', reason: 'the Yatris integration had no project root' })};`;
                },
              },
              {
                name: 'yatris:reservations',
                resolveId: (id: string) => (id === VIRTUAL_RESERVATIONS || id === VIRTUAL_RESERVATIONS_PREVIEW ? `\0${id}` : undefined),
                load(this: { addWatchFile?: (file: string) => void }, id: string) {
                  if (id === `\0${VIRTUAL_RESERVATIONS_PREVIEW}`) {
                    // Production builds get null here, so neither the booking UI nor synthetic data is bundled.
                    return reservationsPreview
                      ? `import '@yatris/astro/YatrisForm.css';\nimport '@yatris/astro/YatrisBooking.css';\nexport { default } from '@yatris/astro/booking/preview';`
                      : 'export default null;';
                  }
                  if (id !== `\0${VIRTUAL_RESERVATIONS}`) return undefined;
                  if (reservationsPreview && formsSource) {
                    // Read the declarations on every load, so edits show up in dev.
                    const dir = join(fileURLToPath(formsSource.root), RESERVATIONS_DIR);
                    for (const name of declarationFiles(dir)) this.addWatchFile?.(join(dir, name));
                    return `export default ${JSON.stringify(reservationsRuntime(formsSource))};`;
                  }
                  return `export default ${JSON.stringify(reservations ?? { mode: 'unconfigured', reason: 'the Yatris integration had no project root' })};`;
                },
              },
            ],
          },
        });
      },
      'astro:build:done': ({ pages, dir, logger }) => {
        if (preview) {
          if (!dir) throw new Error('@yatris/astro: a preview build must mark its output noindex, but Astro gave no output directory.');
          writePreviewHeaders(dir);
          logger.info('preview: Yatris drafts rendered; every page and response is noindex, nofollow');
        } else {
          const mode = previewBuild();
          if (!mode.active && mode.reason) logger.info(mode.reason);
        }
        const navigation = registeredNavigation();
        if (!navigation) {
          logger.warn('src/navigation.ts was not used by any built page, so its destinations were not checked.');
          return;
        }
        const missing = missingDestinations(navigation, pages.map((p) => p.pathname));
        if (missing.length > 0) {
          const list = missing.map((item) => `  - ${item.label} → ${item.href}`).join('\n');
          throw new Error(`Navigation points to pages that were not built:\n${list}`);
        }
        logger.info(`navigation: all ${countDestinations(navigation)} destinations resolve`);
      },
    },
  };
}

function countDestinations(items: { children?: unknown[] }[]): number {
  return items.reduce((n, item) => n + 1 + countDestinations((item.children ?? []) as { children?: unknown[] }[]), 0);
}
