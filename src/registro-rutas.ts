import { existsSync } from 'fs';
import Module = require('module');
import { resolve } from 'path';

// Permite resolver NestJS y @nestjs/jwt desde ../backend/node_modules mientras graphql vive dentro del monorepo.
// `graphql` (graphql-js) sí sale de graphql/node_modules (npm ci con graphql/package-lock.json).
const rutaBackendNodeModules = resolve(__dirname, '..', '..', 'backend', 'node_modules');
if (existsSync(rutaBackendNodeModules)) {
  const separador = process.platform === 'win32' ? ';' : ':';
  const actuales = process.env.NODE_PATH ? process.env.NODE_PATH.split(separador).filter(Boolean) : [];
  if (!actuales.includes(rutaBackendNodeModules)) {
    process.env.NODE_PATH = [...actuales, rutaBackendNodeModules].join(separador);
    (Module as unknown as { _initPaths?: () => void })._initPaths?.();
  }
}

