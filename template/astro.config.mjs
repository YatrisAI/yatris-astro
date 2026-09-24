// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import alpinejs from '@astrojs/alpinejs';
import yatris from '@yatris/astro';

// https://astro.build/config
export default defineConfig({
  // Set the production origin (e.g. 'https://www.example.co.jp') once it is
  // known; canonical and social URLs are built from it.
  // site: 'https://www.example.co.jp',

  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [alpinejs({ entrypoint: '/src/scripts/alpine' }), yatris()]
});
