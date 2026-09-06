import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

// Base path must match the GitHub Pages project URL:
// https://<user>.github.io/les-bons-comptes/
export default defineConfig({
  base: '/les-bons-comptes/',
  define: {
    // Figés au moment du build (pas à l'exécution) : la date reflète donc le dernier
    // déploiement, mis à jour automatiquement à chaque push sur main par la CI.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
});
