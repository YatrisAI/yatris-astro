import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreviewBookingConfig } from './booking-client/types.js';
import { declarationFiles } from './forms-config.js';
import { readPairedProject } from './paired-build.js';
import { DEFAULT_BOOKING_ORIGIN, parseBookingOrigin } from './reservations/embed.js';
import { reservationPublicContent } from './reservations/public.js';
import { validateSetup } from './reservations/setup.js';
import type { HoursEntry, ReservationOperations, ReservationResource, ReservationSetup } from './reservations/types.js';

/**
 * Build-time side of `<ReservationEmbed>` (YatrisCMS#421): how reservation
 * embeds on this build load, as the `virtual:yatris/reservations` runtime.
 *
 * - **live**: a paired project. Each embed is an iframe to
 *   `<booking origin>/book/<websiteId>/<setupKey>` (default origin
 *   https://book.yatris.jp; YATRIS_BOOKING_ORIGIN overrides it for local
 *   development).
 * - **preview**: `astro dev` with YATRIS_RESERVATIONS_PREVIEW=1 only. Embeds
 *   render `src/reservations/<key>.json` locally against clearly labelled
 *   synthetic hosts and availability, and send nothing.
 * - **unconfigured**: an unpaired project outside preview. Embeds show the
 *   unavailable state. Nothing ever falls back to preview.
 *
 * `astro build` refuses YATRIS_RESERVATIONS_PREVIEW outright, and a build
 * never reads `src/reservations/`.
 */

export const RESERVATIONS_PREVIEW_ENV = 'YATRIS_RESERVATIONS_PREVIEW';
export const BOOKING_ORIGIN_ENV = 'YATRIS_BOOKING_ORIGIN';
export const RESERVATIONS_DIR = 'src/reservations';

export interface ReservationPreviewEntry {
  source: string;
  definition?: PreviewBookingConfig['definition'];
  synthetic?: PreviewBookingConfig['synthetic'];
  problem?: PreviewBookingConfig['problem'];
}

export type ReservationsRuntime =
  | { mode: 'live'; bookingOrigin: string; websiteId: number }
  | { mode: 'preview'; previews: Record<string, ReservationPreviewEntry> }
  | { mode: 'unconfigured'; reason: string };

/** Whether YATRIS_RESERVATIONS_PREVIEW asks for preview. Unknown values are an error, not a guess. */
export function reservationsPreviewRequested(env: Record<string, string | undefined>): boolean {
  const raw = env[RESERVATIONS_PREVIEW_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error(`@yatris/astro: ${RESERVATIONS_PREVIEW_ENV}=${raw} is not understood; use 1 to preview reservations under astro dev, or leave it unset.`);
}

/** Refuses preview anywhere but `astro dev`. Throws for a production build. */
export function assertReservationsMode(command: string | undefined, env: Record<string, string | undefined>): boolean {
  const requested = reservationsPreviewRequested(env);
  if (requested && command === 'build') {
    throw new Error(
      `@yatris/astro: ${RESERVATIONS_PREVIEW_ENV} is set, but the reservations preview only runs under \`astro dev\`. A production build never ships synthetic availability. Unset ${RESERVATIONS_PREVIEW_ENV} (keep it in .env.development.local, which builds do not read) and build again.`,
    );
  }
  return requested && command === 'dev';
}

/** The booking origin: YATRIS_BOOKING_ORIGIN (https, or http on loopback), else https://book.yatris.jp. */
export function bookingOrigin(env: Record<string, string | undefined>): string {
  const raw = env[BOOKING_ORIGIN_ENV]?.trim();
  if (!raw) return DEFAULT_BOOKING_ORIGIN;
  try {
    return parseBookingOrigin(raw);
  } catch (error) {
    throw new Error(`@yatris/astro: ${BOOKING_ORIGIN_ENV}: ${(error as Error).message}`);
  }
}

export interface ReservationsRuntimeSource {
  root: URL;
  command: 'dev' | 'build' | 'preview' | 'sync' | undefined;
  env: Record<string, string | undefined>;
}

export function reservationsRuntime(source: ReservationsRuntimeSource): ReservationsRuntime {
  const preview = assertReservationsMode(source.command, source.env);
  const origin = bookingOrigin(source.env);
  if (preview) return { mode: 'preview', previews: loadReservationPreviews(source.root) };
  const project = readPairedProject(source.root);
  if (!project) return { mode: 'unconfigured', reason: 'this project is not paired with a Yatris Website yet (run `npx yatris connect`), so there is no booking page to embed' };
  return { mode: 'live', bookingOrigin: origin, websiteId: project.websiteId };
}

const SAMPLE_HOST_KEYS = ['sample_host_a', 'sample_host_b'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Obviously fake host names for the preview. */
export const syntheticHostLabel = (index: number) => `架空の担当者${LETTERS[index % 26]}（サンプル）`;

/**
 * Synthetic operations for previewing a setup: its own seed where it has one
 * (hosts relabelled with obviously fake names), otherwise a fixed sample.
 * Throws when the setup is not a time-slot setup (other modes preview later).
 */
export function syntheticOperations(setup: ReservationSetup): ReservationOperations {
  const seed = setup.operations ?? {};
  const hostKeys = seed.appointment?.hostResourceKeys ?? SAMPLE_HOST_KEYS;
  const others: ReservationResource[] = (seed.resources ?? []).filter((r) => !hostKeys.includes(r.key));
  const hosts: ReservationResource[] = hostKeys.map((key, i) => {
    const existing = seed.resources?.find((r) => r.key === key);
    return { ...(existing ?? { kind: 'host' as const }), key, kind: 'host', label: syntheticHostLabel(i) };
  });
  return {
    ...seed,
    confirmationMode: seed.confirmationMode ?? 'automatic',
    resources: [...hosts, ...others],
    appointment: seed.appointment ?? { durationMinutes: 30, hostStrategy: 'one_available', hostResourceKeys: hostKeys, visitorChoosesHost: false },
  };
}

/** The hours synthetic availability follows: the first host's, else the venue's, else none (the fixed sample). */
function syntheticHours(operations: ReservationOperations): { weeklyHours: HoursEntry[]; exceptions?: NonNullable<ReservationOperations['venueHours']>['exceptions'] } {
  const host = operations.resources?.find((r) => r.key === operations.appointment?.hostResourceKeys[0]);
  const weeklyHours = host?.weeklyHours?.length ? host.weeklyHours : (operations.venueHours?.weekly ?? []);
  const exceptions = operations.venueHours?.exceptions;
  return { weeklyHours, ...(exceptions?.length ? { exceptions } : {}) };
}

/** Preview entries for every local declaration (`src/reservations/*.json`, not `*.brief.json`). */
export function loadReservationPreviews(root: URL): Record<string, ReservationPreviewEntry> {
  const dir = join(fileURLToPath(root), RESERVATIONS_DIR);
  const previews: Record<string, ReservationPreviewEntry> = {};
  for (const name of declarationFiles(dir)) {
    const key = name.slice(0, -'.json'.length);
    const source = `${RESERVATIONS_DIR}/${name}`;
    previews[key] = previewEntry(key, source, () => readFileSync(join(dir, name), 'utf8'));
  }
  return previews;
}

export function previewEntry(key: string, source: string, read: () => string): ReservationPreviewEntry {
  let value: unknown;
  try {
    value = JSON.parse(read());
  } catch (error) {
    return { source, problem: { message: `${source} は JSON として読み込めません（${(error as Error).message}）。`, issues: [] } };
  }
  const result = validateSetup(value);
  if (!result.valid) return { source, problem: { message: `${source} に誤りがあります。npx yatris reservations validate で確認してください。`, issues: result.errors } };
  const setup = value as ReservationSetup;
  if (setup.key !== key) return { source, problem: { message: `${source} の key は「${key}」である必要があります（現在は「${setup.key}」）。`, issues: [{ path: '/key', code: 'filename_mismatch' }] } };
  if (setup.mode !== 'time_slot') {
    return { source, problem: { message: `${source} は ${setup.mode} モードです。このバージョンのプレビューは時間枠（time_slot）の予約のみに対応しています。`, issues: [] } };
  }
  const operations = syntheticOperations(setup);
  return { source, ...syntheticDefinition(setup, operations, source) };
}

function syntheticDefinition(setup: ReservationSetup, operations: ReservationOperations, source: string): Pick<ReservationPreviewEntry, 'definition' | 'synthetic' | 'problem'> {
  try {
    return { definition: previewDefinition(setup, operations), synthetic: syntheticHours(operations) };
  } catch {
    return { problem: { message: `${source} からプレビュー用のサンプル設定を作成できませんでした。質問の条件が、operations にない場所や担当者を参照していないか確認してください。`, issues: [] } };
  }
}

/**
 * The public projection (README §5) of a setup with synthetic operations:
 * the same allowlist as a live definition, so meeting URLs, addresses and
 * other private seed values never reach the preview page. Preview endpoints,
 * no Turnstile, no digest.
 */
export function previewDefinition(setup: ReservationSetup, operations: ReservationOperations): NonNullable<PreviewBookingConfig['definition']> {
  const { setup: head, ...rest } = reservationPublicContent({ ...setup, operations }, operations);
  return {
    ...rest,
    setup: { ...head, version: 1, operationsRevision: 1, digest: 'sha256:preview' },
    turnstile: null,
    endpoints: { availability: 'preview:availability', holds: 'preview:holds', bookings: 'preview:bookings', receipt: 'preview:receipt' },
  };
}
