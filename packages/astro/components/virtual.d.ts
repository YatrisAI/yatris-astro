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
