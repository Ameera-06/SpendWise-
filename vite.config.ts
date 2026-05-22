/// <reference types="node" />
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  return {
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          signup: path.resolve(__dirname, 'signup.html'),
          dashboard: path.resolve(__dirname, 'dashboard.html'),
          history: path.resolve(__dirname, 'history.html'),
          forgot: path.resolve(__dirname, 'forgot-password.html'),
        },
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env['DISABLE_HMR'] !== 'true',
    },
  };
});
