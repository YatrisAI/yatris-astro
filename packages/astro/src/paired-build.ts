import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a paired site's production build needs to ask Yatris about itself:
 * the Website id and the Yatris origin, both from `.yatris/project.json`.
 * Shared by the measurement settings and the schema contract check.
 */

export interface PairedProject {
  websiteId: number;
  deliveryEndpoint: string | null;
  /** The Website's IANA time zone, when Yatris recorded one. */
  timezone?: string | null;
}

/** The paired project at `root`, or null for an unpaired (scaffold-stage) one. */
export function readPairedProject(root: URL): PairedProject | null {
  const path = join(fileURLToPath(root), '.yatris/project.json');
  if (!existsSync(path)) return null;
  const project = JSON.parse(readFileSync(path, 'utf8')) as { websiteId?: unknown; deliveryEndpoint?: unknown; site?: { timezone?: unknown } };
  if (typeof project.websiteId !== 'number') return null;
  return {
    websiteId: project.websiteId,
    deliveryEndpoint: typeof project.deliveryEndpoint === 'string' ? project.deliveryEndpoint : null,
    timezone: typeof project.site?.timezone === 'string' ? project.site.timezone : null,
  };
}

/** The Yatris origin for a paired project: `YATRIS_URL`, else the origin of its Delivery endpoint. */
export function yatrisOrigin(project: PairedProject, env: Record<string, string | undefined>): string | null {
  const origin = env.YATRIS_URL ?? (project.deliveryEndpoint ? new URL(project.deliveryEndpoint).origin : null);
  return origin ? origin.replace(/\/$/, '') : null;
}

/** `{origin}/api/v1/sites/{id}/{path}` for a paired project; `YATRIS_URL` overrides the origin. */
export function siteApiUrl(project: PairedProject, path: string, env: Record<string, string | undefined>): string {
  const origin = yatrisOrigin(project, env);
  if (!origin) throw new Error('@yatris/astro: this project is paired but .yatris/project.json has no Yatris origin; run `npx yatris connect` again.');
  return `${origin}/api/v1/sites/${project.websiteId}/${path}`;
}
