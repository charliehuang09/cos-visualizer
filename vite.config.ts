import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Three.js is loaded when the visualizer starts; its production chunk is
    // about 795 kB minified, so keep warnings for chunks that exceed that
    // deliberate baseline.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /[\\/]node_modules[\\/]three[\\/]/,
            },
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'react-three-fiber',
              test: /[\\/]node_modules[\\/]@react-three[\\/]fiber[\\/]/,
            },
          ],
        },
      },
    },
  },
})
