/**
 * Measurement helpers for site code (YatrisCMS#271 / spec §15). Site code
 * never calls `gtag()` or writes GTM snippets (`yatris doctor` refuses both);
 * it sends semantic events and consent decisions through these.
 *
 * They run in the browser and do nothing on the server or before GTM loads:
 * events queue on `window.dataLayer`, which GTM drains when it starts.
 */

import { CONSENT_STORAGE_KEY, GTM_CONSENT_LOADER } from './head.js';

type Primitive = string | number | boolean;

/** A consent decision from the site's own consent UI. */
export interface ConsentChoice {
  /** Analytics measurement (GA4 via GTM, and Yatris heatmaps). */
  analytics: boolean;
  /** Advertising storage, user data and personalisation. */
  ads: boolean;
}

interface MeasurementWindow {
  dataLayer?: unknown[];
  AutoLogicriHM?: { consent(granted: boolean): void };
  [GTM_CONSENT_LOADER]?: (choice: ConsentChoice) => void;
}

const EVENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;

function target(): MeasurementWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as MeasurementWindow);
}

function dataLayer(w: MeasurementWindow): unknown[] {
  w.dataLayer = w.dataLayer ?? [];
  return w.dataLayer;
}

/**
 * Sends a semantic event, such as `trackEvent('contact_submit', { form: 'inquiry' })`.
 * Names are snake_case so they map one-to-one to GA4 events configured in GTM.
 */
export function trackEvent(name: string, params: Record<string, Primitive> = {}): void {
  if (!EVENT_NAME.test(name)) throw new Error(`trackEvent: event names are snake_case (got ${JSON.stringify(name)})`);
  const w = target();
  if (w === null) return;
  dataLayer(w).push({ event: name, ...params });
}

/**
 * The decision an earlier `updateConsent()` stored, or null when the visitor
 * has not decided yet (show the consent UI then).
 */
export function storedConsent(): ConsentChoice | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null') as Partial<ConsentChoice> | null;
    return value && typeof value.analytics === 'boolean' && typeof value.ads === 'boolean' ? { analytics: value.analytics, ads: value.ads } : null;
  } catch {
    return null;
  }
}

/**
 * Records the visitor's consent decision: it is stored for later page views,
 * sent to Google's Consent Mode and to the Yatris heatmap's own switch.
 *
 * When the site's policy requires consent (Google's basic consent mode), GTM
 * is not on the page at all until this is called with `analytics: true`; this
 * call then loads it. Withdrawing consent later stops GTM from loading on the
 * next page view and sends a denied update to the one already running.
 */
export function updateConsent(choice: ConsentChoice): void {
  const w = target();
  if (w === null) return;

  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ analytics: choice.analytics, ads: choice.ads }));
  } catch {
    // Storage blocked: the decision holds for this page view only
  }
  w[GTM_CONSENT_LOADER]?.(choice);

  const granted = (yes: boolean) => (yes ? 'granted' : 'denied');
  // Consent Mode reads the arguments object gtag() would push
  (function consent(..._args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    dataLayer(w).push(arguments);
  })('consent', 'update', {
    analytics_storage: granted(choice.analytics),
    ad_storage: granted(choice.ads),
    ad_user_data: granted(choice.ads),
    ad_personalization: granted(choice.ads),
  });
  dataLayer(w).push({ event: 'yatris_consent_update', analytics: choice.analytics, ads: choice.ads });

  w.AutoLogicriHM?.consent(choice.analytics);
}
