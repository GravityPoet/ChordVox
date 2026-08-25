import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_DEV_SERVER_PORT = 5183
const PACKAGE_CHUNK_GROUPS = {
  react: 'vendor-react',
  'react-dom': 'vendor-react',
  scheduler: 'vendor-react',
  i18next: 'vendor-i18n',
  'react-i18next': 'vendor-i18n',
  '@neondatabase/auth': 'vendor-neon',
  '@radix-ui/react-accordion': 'vendor-radix',
  '@radix-ui/react-dialog': 'vendor-radix',
  '@radix-ui/react-dropdown-menu': 'vendor-radix',
  '@radix-ui/react-label': 'vendor-radix',
  '@radix-ui/react-progress': 'vendor-radix',
  '@radix-ui/react-select': 'vendor-radix',
  '@radix-ui/react-slot': 'vendor-radix',
  '@radix-ui/react-tabs': 'vendor-radix',
  'lucide-react': 'vendor-icons',
}
const SOURCE_CHUNK_RULES = [
  [/\/src\/components\/capsule\//, 'app-capsule'],
  [/\/src\/(?:services|models|config|utils)\//, 'app-runtime'],
]

const parseDevServerPort = (rawPort) => {
  const normalizedPort = rawPort || String(DEFAULT_DEV_SERVER_PORT)
  const parsedPort = Number(normalizedPort)

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return DEFAULT_DEV_SERVER_PORT
  }

  return parsedPort
}

const normalizeModuleId = (id) => id.split(path.sep).join('/')

const getPackageName = (id) => {
  const normalizedId = normalizeModuleId(id)
  const nodeModulesPath = normalizedId.split('/node_modules/')[1]

  if (!nodeModulesPath) {
    return null
  }

  const parts = nodeModulesPath.split('/')
  if (parts[0].startsWith('@')) {
    return `${parts[0]}/${parts[1]}`
  }

  return parts[0]
}

const getLocaleChunkName = (id) => {
  const normalizedId = normalizeModuleId(id)
  const localeMatch = normalizedId.match(/\/src\/locales\/([^/]+)\//)

  if (!localeMatch) {
    return null
  }

  return `locale-${localeMatch[1].replace(/[^a-zA-Z0-9]+/g, '_')}`
}

const getSourceChunkName = (id) => {
  const normalizedId = normalizeModuleId(id)
  const matchedRule = SOURCE_CHUNK_RULES.find(([pattern]) => pattern.test(normalizedId))
  return matchedRule?.[1] || null
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, '..')
  const env = loadEnv(mode, envDir, '')
  const rawPort = env.VITE_DEV_SERVER_PORT || env.CHORDVOX_DEV_SERVER_PORT
  const devServerPort = parseDevServerPort(rawPort)

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'write-runtime-env',
        writeBundle() {
          const runtimeEnv = {
            VITE_CHORDVOX_API_URL: env.VITE_CHORDVOX_API_URL || '',
            VITE_NEON_AUTH_URL: env.VITE_NEON_AUTH_URL || '',
          }
          fs.writeFileSync(
            path.resolve(__dirname, 'dist', 'runtime-env.json'),
            JSON.stringify(runtimeEnv)
          )
        },
      },
    ],
    base: './', // Use relative paths for file:// protocol in Electron
    envDir, // Load .env from project root
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
    server: {
      port: devServerPort,
      strictPort: true,
      host: '127.0.0.1', // Use IP address instead of localhost for Neon Auth CORS
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        external: [
          'electron',
          'fs',
          'path',
          'child_process',
          'https',
          'http',
          'crypto',
          'os',
          'stream',
          'util',
          'zlib',
          'tar',
          'unzipper',
          '@aws-sdk/client-s3'
        ],
        output: {
          manualChunks(id) {
            const localeChunkName = getLocaleChunkName(id)
            if (localeChunkName) {
              return localeChunkName
            }

            const sourceChunkName = getSourceChunkName(id)
            if (sourceChunkName) {
              return sourceChunkName
            }

            const packageName = getPackageName(id)
            if (!packageName) {
              return undefined
            }

            return PACKAGE_CHUNK_GROUPS[packageName]
          },
        },
      }
    }
  }
})
