import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
export default defineConfig({
  // ...plugin dan isi lain tetap
  server: {
    allowedHosts: [".trycloudflare.com", ".tunnelmole.net"],
    proxy: {
      "/api": "http://localhost:5000",
      "/uploads": "http://localhost:5000",
    },
  },
});
