import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:phone` serves over self-signed HTTPS on the LAN:
// browsers only allow GPS on secure origins (localhost or https).
export default defineConfig(({ mode }) => ({
  plugins: mode === 'phone' ? [basicSsl()] : [],
}));
