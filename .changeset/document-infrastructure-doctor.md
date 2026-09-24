---
'create-yatris': minor
'@yatris/astro': minor
---

Document infrastructure and scaffold diagnostics. `@yatris/astro` adds the `yatris()` integration, `YatrisHead` and `YatrisBodyStart` components with the `YatrisPageMeta` contract (title, description, canonical, robots, social metadata, structured data, Search Console verification, and Google Tag Manager only when a container ID is configured), and fails the build when a `src/navigation.ts` destination was not built. `yatris doctor --stage=scaffold` checks the repository contract, lints `src/` and audits the build output (titles, language, canonical, duplicate or hand-written Google tags, runtime CDNs, leaked credentials). Generated sites use the components and get an `npm run doctor` script.
