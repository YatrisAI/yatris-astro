declare module 'virtual:yatris/config' {
  const config: import('@yatris/astro/head').YatrisRuntimeConfig;
  export default config;
}

declare module 'virtual:yatris/forms' {
  const runtime: import('@yatris/astro/forms/mount').FormsRuntime;
  export default runtime;
}

/** The forms preview module under `astro dev` with YATRIS_FORMS_PREVIEW=1; null in every build. */
declare module 'virtual:yatris/forms-preview' {
  const preview: import('@yatris/astro/forms/client').PreviewModule | null;
  export default preview;
}

declare module 'virtual:yatris/reservations' {
  const runtime: import('@yatris/astro/reservations/mount').ReservationsRuntime;
  export default runtime;
}

/** The reservations preview mounter under `astro dev` with YATRIS_RESERVATIONS_PREVIEW=1; null in every build. */
declare module 'virtual:yatris/reservations-preview' {
  const preview: import('@yatris/astro/reservations/embed').BookingPreviewModule | null;
  export default preview;
}
