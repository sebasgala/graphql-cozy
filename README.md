# Servidor GraphQL (`graphql-cozy`)

Punto de consolidación de datos para la interfaz de usuario de Cozy. Expone un esquema GraphQL unificado (37 operaciones: 17 queries y 20 mutations) delegando directamente en las rutas REST v1 de los servicios dueños.

## Características
- **Esquema SDL (`schema.graphql`):** Versionado con SemVer 1.0.0.
- **Sin base de datos propia:** Resuelve mediante llamadas HTTP internas a `usuarios`, `catalogo`, `disponibilidad` y `reservas`.
- **Autenticación RS256:** Verifica el JWT de la UI con la clave pública de `usuarios`. Rechaza tokens con scope (OAuth de Booking) inmediatamente con `FORBIDDEN`.
- **ProblemDetails en extensions:** Los errores de los servicios se devuelven en `errors[].extensions` preservando `code`, `status` y `detail`.

## Instalación y compilación
```bash
npm ci
npm run build
```

## Pruebas
```bash
npm test
```

