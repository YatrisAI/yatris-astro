import { validateQuestions } from '../forms/declaration.js';
import { canonicalJson, sha256Hex } from '../forms/hash.js';
import { reservationContext } from './context.js';
import { projectNode } from '../forms/public.js';
import type { FormNode } from '../forms/tree.js';
import { validateOperations } from './operations.js';
import { DEFAULT_POLICIES, RESERVATION_CONTRACT_VERSION } from './registry.js';
import { validateSetup } from './setup.js';
import type { ReservationOperations, ReservationSetup } from './types.js';

/**
 * The public definition of a published setup (README "Public definition"):
 * labels, allowed choices, durations, policies and public questions, built
 * by an explicit allowlist. Never meeting URLs, addresses, instructions,
 * resource hours, capacities, seats, table data, reminders, recipients or
 * quiz answers. Yatris serves the PHP twin of this projection.
 */

export interface ReservationPublicMeta {
  /** Published setup version. */
  version: number;
  /** Live operations revision. */
  operationsRevision: number;
  turnstile: { siteKey: string; action: string } | null;
  /** Endpoint URLs, copied as given. */
  endpoints: Record<string, string>;
}

type Labelled = { key: string; label: string };

export interface ReservationPolicies {
  timezone: string;
  slotIntervalMinutes: number;
  bookingHorizonDays: number;
  minimumLeadMinutes: number;
  holdMinutes: number;
  confirmationMode: 'automatic' | 'manual';
  approvalWindowMinutes?: number;
  cancelCutoffMinutes: number;
  rescheduleCutoffMinutes: number;
}

export interface ReservationPublicContent {
  contractVersion: 1;
  setup: { key: string; name: string; locale: string; mode: string; presentation?: string };
  questions: FormNode[];
  identityFields: { name: string; email: string; phone?: string };
  copy: { pendingMessage?: string; confirmedMessage?: string };
  success: { redirectPath: string } | null;
  policies: ReservationPolicies;
  locations: { key: string; type: string; label: string }[];
  appointment?: { durationMinutes: number; visitorChoosesHost: boolean; hosts: Labelled[] };
  services?: {
    key: string;
    label: string;
    durationMinutes: number;
    variants: { key: string; label: string; durationMinutes: number }[];
    visitorChoosesPractitioner: boolean;
    practitioners: Labelled[];
  }[];
  party?: { minSize: number; maxSize: number; durationMinutes: number };
}

export interface ReservationPublicDefinition extends Omit<ReservationPublicContent, 'setup'> {
  setup: ReservationPublicContent['setup'] & { version: number; operationsRevision: number; digest: string };
  turnstile: { siteKey: string; action: string } | null;
  endpoints: Record<string, string>;
}

/**
 * The body the digest covers: the public definition without
 * `setup.version`, `setup.operationsRevision`, `setup.digest`, `turnstile`
 * and `endpoints`. Throws unless the setup and operations validate without
 * errors and the operations choose a `confirmationMode`.
 */
export function reservationPublicContent(setup: ReservationSetup, operations: ReservationOperations): ReservationPublicContent {
  if (!validateSetup(setup).valid) throw new Error('A public definition needs a valid setup declaration.');
  const presentation = setup.mode === 'business' ? setup.presentation : undefined;
  if (!validateOperations(operations, { mode: setup.mode, presentation }).valid) throw new Error('A public definition needs valid operations.');
  if (operations.confirmationMode === undefined) throw new Error('A public definition needs an explicit confirmationMode.');
  if (!validateQuestions(setup.questions, { context: reservationContext(setup, operations) }).valid) {
    throw new Error('A public definition needs questions that are valid against the live operations.');
  }

  const label = (key: string): Labelled => ({ key, label: operations.resources!.find((r) => r.key === key)!.label });
  const { identityFields, copy = {} } = setup;
  const confirmationMode = operations.confirmationMode;

  const content: ReservationPublicContent = {
    contractVersion: RESERVATION_CONTRACT_VERSION,
    setup: { key: setup.key, name: setup.name, locale: setup.locale, mode: setup.mode, ...(presentation ? { presentation } : {}) },
    questions: setup.questions.map(projectNode),
    identityFields: { name: identityFields.name, email: identityFields.email, ...(identityFields.phone !== undefined ? { phone: identityFields.phone } : {}) },
    copy: {
      ...(copy.pendingMessage !== undefined ? { pendingMessage: copy.pendingMessage } : {}),
      ...(copy.confirmedMessage !== undefined ? { confirmedMessage: copy.confirmedMessage } : {}),
    },
    success: setup.success ? { redirectPath: setup.success.redirectPath } : null,
    policies: {
      timezone: operations.timezone ?? DEFAULT_POLICIES.timezone,
      slotIntervalMinutes: operations.slotIntervalMinutes ?? DEFAULT_POLICIES.slotIntervalMinutes,
      bookingHorizonDays: operations.bookingHorizonDays ?? DEFAULT_POLICIES.bookingHorizonDays,
      minimumLeadMinutes: operations.minimumLeadMinutes ?? DEFAULT_POLICIES.minimumLeadMinutes,
      holdMinutes: operations.holdMinutes ?? DEFAULT_POLICIES.holdMinutes,
      confirmationMode,
      ...(confirmationMode === 'manual' ? { approvalWindowMinutes: operations.approvalWindowMinutes ?? DEFAULT_POLICIES.approvalWindowMinutes } : {}),
      cancelCutoffMinutes: operations.cancelCutoffMinutes ?? DEFAULT_POLICIES.cancelCutoffMinutes,
      rescheduleCutoffMinutes: operations.rescheduleCutoffMinutes ?? DEFAULT_POLICIES.rescheduleCutoffMinutes,
    },
    locations: (operations.locations ?? []).map(({ key, type, label }) => ({ key, type, label })),
  };

  if (setup.mode === 'time_slot') {
    const appointment = operations.appointment!;
    const visitorChoosesHost = appointment.visitorChoosesHost ?? false;
    content.appointment = {
      durationMinutes: appointment.durationMinutes,
      visitorChoosesHost,
      hosts: visitorChoosesHost ? appointment.hostResourceKeys.map(label) : [],
    };
  } else if (presentation === 'service') {
    content.services = operations.services!.map((service) => {
      const visitorChoosesPractitioner = service.visitorChoosesPractitioner ?? false;
      const eligible = [...new Set(service.requirements.flatMap((r) => r.resourceKeys))].filter(
        (key) => operations.resources!.find((r) => r.key === key)!.kind === 'practitioner',
      );
      return {
        key: service.key,
        label: service.label,
        durationMinutes: service.durationMinutes,
        variants: (service.variants ?? []).map(({ key, label, durationMinutes }) => ({ key, label, durationMinutes })),
        visitorChoosesPractitioner,
        practitioners: visitorChoosesPractitioner ? eligible.map(label) : [],
      };
    });
  } else {
    const party = operations.party!;
    content.party = { minSize: party.minSize, maxSize: party.maxSize, durationMinutes: party.durationMinutes };
  }
  return content;
}

/** "sha256:<hex>" of the canonical JSON of the public content. */
export async function reservationDigest(setup: ReservationSetup, operations: ReservationOperations): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(reservationPublicContent(setup, operations)))}`;
}

export async function reservationPublicDefinition(
  setup: ReservationSetup,
  operations: ReservationOperations,
  meta: ReservationPublicMeta,
): Promise<ReservationPublicDefinition> {
  const content = reservationPublicContent(setup, operations);
  const digest = `sha256:${await sha256Hex(canonicalJson(content))}`;
  const { contractVersion, setup: head, appointment, services, party, ...rest } = content;
  return {
    contractVersion,
    setup: { ...head, version: meta.version, operationsRevision: meta.operationsRevision, digest },
    ...rest,
    ...(appointment ? { appointment } : {}),
    ...(services ? { services } : {}),
    ...(party ? { party } : {}),
    turnstile: meta.turnstile,
    endpoints: { ...meta.endpoints },
  };
}
