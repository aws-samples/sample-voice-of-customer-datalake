import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vendor chunks
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('react-router')) {
              return 'vendor-react'
            }
            if (id.includes('recharts') || id.includes('d3-')) {
              return 'vendor-charts'
            }
            if (id.includes('@tanstack/react-query')) {
              return 'vendor-query'
            }
            if (id.includes('react-markdown') || id.includes('remark') || id.includes('unified') || id.includes('mdast') || id.includes('micromark') || id.includes('dompurify')) {
              return 'vendor-markdown'
            }
            if (id.includes('jspdf') || id.includes('html2canvas')) {
              return 'vendor-pdf'
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons'
            }
            if (id.includes('date-fns') || id.includes('zustand') || id.includes('clsx') || id.includes('amazon-cognito')) {
              return 'vendor-utils'
            }
          }
          // Group pages into logical chunks
          if (id.includes('/pages/')) {
            if (id.includes('Dashboard') || id.includes('Feedback/') || id.includes('FeedbackDetail') || id.includes('Categories') || id.includes('ProblemAnalysis')) {
              return 'pages-analytics'
            }
            if (id.includes('Chat') || id.includes('Projects') || id.includes('ProjectDetail') || id.includes('Prioritization')) {
              return 'pages-projects'
            }
            if (id.includes('Settings') || id.includes('Scrapers') || id.includes('FeedbackForms') || id.includes('DataExplorer') || id.includes('ArtifactBuilder')) {
              return 'pages-admin'
            }
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})
