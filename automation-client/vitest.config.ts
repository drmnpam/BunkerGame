import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'coverage/',
      ],
    },
    exclude: [
      'node_modules',
      'dist',
      'tests/**',
      '.idea',
      '.git',
      '.cache',
    ],
  },
});
