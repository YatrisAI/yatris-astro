/** Options for the Yatris Astro integration. Filled in by later releases. */
export type YatrisOptions = Record<string, never>;

/** The subset of Astro's integration shape this package returns today. */
export interface YatrisIntegration {
  name: '@yatris/astro';
  hooks: Record<string, never>;
}

/**
 * The Yatris Astro integration. This release establishes the package and its
 * contract only; document infrastructure and content loading arrive later.
 */
export default function yatris(_options: YatrisOptions = {}): YatrisIntegration {
  return { name: '@yatris/astro', hooks: {} };
}
