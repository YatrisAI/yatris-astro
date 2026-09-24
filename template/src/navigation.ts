import { defineNavigation } from '@yatris/astro/navigation';

// The site's navigation. When you add a page, register it here. Every href
// must be a root-relative path or an https URL; the build fails otherwise.
// How navigation looks is decided by the site's layouts and components.
export default defineNavigation([
  { label: 'ホーム', href: '/' },
]);
