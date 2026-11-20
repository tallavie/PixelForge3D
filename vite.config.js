import { defineConfig } from 'vite';

// Two pages: the home page of the site (index.html) and the app itself (app/index.html).
// public/ holds what is copied as it is: the how-to guide, the pictures of the home page and the Draco decoder.
export default defineConfig({
  base: './',
  server: { port: 5183, strictPort: false, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { home: 'index.html', app: 'app/index.html' } },
  },
});
