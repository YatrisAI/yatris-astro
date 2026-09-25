import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { YatrisRuntimeConfig } from './head.js';

/**
 * Measurement settings for a paired site's production build (YatrisCMS#271 /
 * spec §15): the GTM container ID, the Search Console HTML-tag token and the
 * consent policy live in Yatris, never in the repository, and the build reads
 * them from `GET {yatris}/api/v1/sites/{id}/measurement`.
 *
 * - An unpaired project (scaffold stage) makes no request and renders no tags,
 *   so it still builds offline.
 * - `astro dev` makes no request either: nobody should be measured in dev.
 * - A paired production build that cannot read the settings fails rather than
 *   ship a page whose tags or consent default silently differ from Yatris. The
 *   live deployment is untouched by a failed build. `YATRIS_MEASUREMENT=off`
 *   builds without any measurement, knowingly.
 */

export interface MeasurementSettings {
  gtmContainerId: string | null;
  consentMode: 'not_required' | 'required' | null;
  searchConsoleVerification: string | null;
}

export interface MeasurementSource {
  root: URL;
  command: 'dev' | 'build' | 'preview' | 'sync' | undefined;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const NONE: MeasurementSettings = { gtmContainerId: null, consentMode: null, searchConsoleVerification: null };

/** Null when this build does not take measurement from Yatris. */
export async function loadMeasurement(source: MeasurementSource): Promise<MeasurementSettings | null> {
  const env = source.env ?? process.env;
  const project = readProject(source.root);

  if (project === null || source.command !== 'build') return null;
  if (env.YATRIS_MEASUREMENT === 'off') return NONE;

  const origin = env.YATRIS_URL ?? (project.deliveryEndpoint ? new URL(project.deliveryEndpoint).origin : null);
  if (!origin) throw new Error('@yatris/astro: this project is paired but .yatris/project.json has no Yatris origin; run `npx yatris connect` again.');

  const url = `${origin.replace(/\/$/, '')}/api/v1/sites/${project.websiteId}/measurement`;
  let response: Response;
  try {
    response = await (source.fetch ?? fetch)(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`@yatris/astro: could not read the measurement settings from ${url} (${(error as Error).message}). Set YATRIS_MEASUREMENT=off to build without measurement.`);
  }
  if (!response.ok) {
    throw new Error(`@yatris/astro: reading the measurement settings from ${url} failed with HTTP ${response.status}. Set YATRIS_MEASUREMENT=off to build without measurement.`);
  }

  return parseMeasurement(await response.json());
}

export function parseMeasurement(value: unknown): MeasurementSettings {
  const data = (value ?? {}) as Record<string, unknown>;
  if (data.contractVersion !== 1) throw new Error('@yatris/astro: Yatris returned measurement settings this version cannot read.');

  const gtm = typeof data.gtmContainerId === 'string' ? data.gtmContainerId : null;
  const consent = data.consentMode === 'not_required' || data.consentMode === 'required' ? data.consentMode : null;
  const verification = typeof data.searchConsoleVerification === 'string' ? data.searchConsoleVerification : null;

  if (gtm !== null && !/^GTM-[A-Z0-9]{4,12}$/.test(gtm)) throw new Error(`@yatris/astro: Yatris returned an invalid GTM container ID ${JSON.stringify(gtm)}.`);
  if (verification !== null && !/^[A-Za-z0-9_-]{10,100}$/.test(verification)) throw new Error('@yatris/astro: Yatris returned an invalid Search Console token.');
  // Decision 10.3: no tag until the consent policy is settled
  if (gtm !== null && consent === null) throw new Error('@yatris/astro: a GTM container arrived without a consent policy; refusing to render it.');

  return { gtmContainerId: gtm, consentMode: consent, searchConsoleVerification: verification };
}

/** Applies Yatris's settings; site options may not also set them once paired. */
export function withMeasurement(config: YatrisRuntimeConfig, measurement: MeasurementSettings | null, optionsSetMeasurement: boolean): YatrisRuntimeConfig {
  if (measurement === null) return config;
  if (optionsSetMeasurement) {
    throw new Error('@yatris/astro: this site is paired with Yatris, so GTM and Search Console are set in Yatris (接続・診断), not in astro.config. Remove gtmContainerId/searchConsoleVerification from the integration options.');
  }
  return { ...config, ...measurement };
}

function readProject(root: URL): { websiteId: number; deliveryEndpoint: string | null } | null {
  const path = join(fileURLToPath(root), '.yatris/project.json');
  if (!existsSync(path)) return null;
  const project = JSON.parse(readFileSync(path, 'utf8')) as { websiteId?: unknown; deliveryEndpoint?: unknown };
  if (typeof project.websiteId !== 'number') return null;
  return { websiteId: project.websiteId, deliveryEndpoint: typeof project.deliveryEndpoint === 'string' ? project.deliveryEndpoint : null };
}
