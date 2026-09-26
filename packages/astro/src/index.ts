import { resolveConfig, type YatrisOptions } from './config.js';
import { loadDeliveryEnv } from './env.js';
import { loadMeasurement, withMeasurement } from './measurement-config.js';
import { missingDestinations, registeredNavigation } from './navigation.js';

export type { YatrisOptions } from './config.js';
export type { YatrisPageMeta } from './head.js';
export type { NavigationItem } from './navigation.js';

const VIRTUAL_CONFIG = 'virtual:yatris/config';

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
    }) => Promise<void>;
    'astro:build:done': (options: { pages: { pathname: string }[]; logger: Logger }) => void;
  };
}

/**
 * The Yatris Astro integration. It feeds site-level settings to
 * `YatrisHead`/`YatrisBodyStart` and fails the build when a navigation
 * destination was not built.
 */
export default function yatris(options: YatrisOptions = {}): YatrisIntegration {
  const config = resolveConfig(options);

  return {
    name: '@yatris/astro',
    hooks: {
      'astro:config:setup': async ({ config: astroConfig, command, updateConfig }) => {
        if (astroConfig) await loadDeliveryEnv(astroConfig.root, command === 'dev' ? 'development' : 'production');
        // YatrisCMS#271: a paired site's production build takes GTM, Search
        // Console and consent from Yatris
        const measurement = astroConfig ? await loadMeasurement({ root: astroConfig.root, command }) : null;
        const runtime = withMeasurement(config, measurement, Boolean(options.gtmContainerId || options.searchConsoleVerification));
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'yatris:config',
                resolveId: (id: string) => (id === VIRTUAL_CONFIG ? `\0${VIRTUAL_CONFIG}` : undefined),
                load: (id: string) => (id === `\0${VIRTUAL_CONFIG}` ? `export default ${JSON.stringify(runtime)};` : undefined),
              },
            ],
          },
        });
      },
      'astro:build:done': ({ pages, logger }) => {
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
