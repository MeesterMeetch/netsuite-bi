import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// CHANGE 'netsuite-bi' below to your repository name if different.
// If deploying to https://<username>.github.io/<repo>/, base must be '/<repo>/'.
// If deploying to a user/organization page (https://<username>.github.io/),
// set base to '/'.
export default defineConfig({
  plugins: [react()],
  base: '/netsuite-bi/',
})