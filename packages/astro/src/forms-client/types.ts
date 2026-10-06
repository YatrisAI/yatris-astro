import type { PublicDefinition } from '../forms/public.js';
import type { Issue } from '../forms/spec.js';

/** Elements whose class list `<YatrisForm classes={…}>` can extend. */
export const CLASS_SLOTS = ['root', 'form', 'field', 'label', 'input', 'choice', 'help', 'error', 'actions', 'submit', 'success'] as const;
export type ClassSlot = (typeof CLASS_SLOTS)[number];

/**
 * The configuration `<YatrisForm>` writes into the page for one mount. It is
 * public by construction: a live mount carries only identifiers and URLs;
 * a preview mount (astro dev only) carries the public projection of the
 * local declaration, never the declaration itself.
 */
export type MountConfig = LiveMountConfig | PreviewMountConfig | UnconfiguredMountConfig;

interface MountBase {
  /** The declaration key, e.g. "contact". */
  form: string;
  /** The Website's IANA time zone, for date-time validation. */
  timeZone: string;
  /** Values for declared `hidden` fields; other keys are ignored. */
  hidden?: Record<string, string>;
  /** Extra classes per element slot. */
  classes?: Partial<Record<ClassSlot, string>>;
}

export interface LiveMountConfig extends MountBase {
  mode: 'live';
  /** "<websiteId>.<formKey>" */
  publicKey: string;
  /** `<Yatris origin>/api/v1/forms/<publicKey>` */
  definitionUrl: string;
}

export interface PreviewMountConfig extends MountBase {
  mode: 'preview';
  /** The local declaration file, for the preview marker. */
  source: string;
  /** Public projection of the local declaration (quiz answers and mail stripped). */
  definition?: PublicDefinition;
  /** Why no definition could be built: a missing or invalid declaration. */
  problem?: { message: string; issues: Issue[] };
}

export interface UnconfiguredMountConfig extends MountBase {
  mode: 'unconfigured';
  /** Developer-facing reason (console only). */
  reason: string;
}

/** What a preview module adds to a mount (see ./preview.ts). */
export interface PreviewHooks {
  fetch: typeof fetch;
  decorate(root: HTMLElement): void;
}

export interface PreviewModule {
  createPreview(config: PreviewMountConfig): PreviewHooks;
}
