import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // Pre-bundle the UI together on startup instead of discovering HeroUI mid-request.
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@heroui/react', 'lucide-react'],
  },
  server: { port: 5173, strictPort: true },
});
