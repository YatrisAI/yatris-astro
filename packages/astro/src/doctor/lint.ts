import { findCredentials, type Finding } from './findings.js';

const RULES: { code: string; severity: Finding['severity']; pattern: RegExp; message: string }[] = [
  {
    code: 'direct-tag',
    severity: 'error',
    pattern: /googletagmanager\.com|\bgtag\s*\(/,
    message: 'hand-written Google tag; configure GTM in Yatris and let YatrisHead/YatrisBodyStart render it',
  },
  {
    code: 'public-credential',
    severity: 'error',
    pattern: /\bPUBLIC_[A-Z0-9_]*(?:DELIVERY|YATRIS[A-Z0-9_]*KEY)[A-Z0-9_]*/,
    message: 'a PUBLIC_ environment variable exposes a Yatris credential to the browser',
  },
  {
    code: 'direct-delivery',
    severity: 'error',
    pattern: /\/api\/v1\/delivery\b|YATRIS_DELIVERY_(?:ENDPOINT|API_KEY)/,
    message: 'reads the Delivery API directly; use getYatrisList/getYatrisSingleton/getYatrisItem from @yatris/astro/delivery',
  },
  {
    code: 'cdn-script',
    severity: 'error',
    pattern: /<script\b[^>]*\bsrc=["']?(?:https?:)?\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev|ga\.jspm\.io)/i,
    message: 'script loaded from a runtime CDN; install it as a pinned npm dependency',
  },
  {
    code: 'x-html',
    severity: 'warning',
    pattern: /\bx-html\b/,
    message: 'x-html renders raw HTML; never use it for untrusted or CMS content without the approved sanitiser',
  },
  {
    code: 'dynamic-class',
    severity: 'warning',
    pattern: /`[^`]*\b[a-z]+(?:-[a-z]+)*-\$\{/,
    message: "Tailwind class assembled from fragments; source detection cannot see it — map values to complete class names",
  },
];

/** Lints one source file under `src/`. */
export function lintSource(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) findings.push({ severity: rule.severity, code: rule.code, message: rule.message, file });
  }
  return [...findings, ...findCredentials(file, text)];
}
