import { JwtService } from '@nestjs/jwt';
import { errorPropio } from './problemas';

// Autenticación de graphql (§9, «Autenticación»). Verifica el Bearer de la UI con la clave PÚBLICA de usuarios (D3, RS256):
// graphql nunca firma. Orden de resolución de la clave: JWT_PUBLIC_KEY, la que publica usuarios en
// /api/v1/interno/usuarios/clave-publica y, solo para pruebas sin par RSA, JWT_SECRET (HS256, mínimo 32 caracteres).

export type RolSesion = 'cliente' | 'administrador' | 'superadmin' | 'recepcion';
export type EstadoSesion = 'activo' | 'pendiente' | 'suspendido';
export type Acceso = 'publico' | 'opcional' | 'sesion' | 'recepcion' | 'admin' | 'superadmin';

export interface Sesion {
  id: string;
  rol: RolSesion;
  estado: EstadoSesion;
}

const ES_UUID = /^[0-9a-f-]{36}$/i;
const ROLES: RolSesion[] = ['cliente', 'administrador', 'superadmin', 'recepcion'];
const ESTADOS: EstadoSesion[] = ['activo', 'pendiente', 'suspendido'];

// recepcion (Bloque R) solo entra a `sesion` y `recepcion`: nunca a catálogo, precios ni usuarios
export const ROLES_POR_ACCESO: Record<Exclude<Acceso, 'publico' | 'opcional'>, RolSesion[]> = {
  sesion: ['cliente', 'administrador', 'superadmin', 'recepcion'],
  recepcion: ['recepcion', 'administrador', 'superadmin'],
  admin: ['administrador', 'superadmin'],
  superadmin: ['superadmin'],
};

export function normalizarPem(valor: string | undefined): string | undefined {
  const limpio = valor?.trim().replace(/\\n/g, '\n');
  return limpio ? limpio : undefined;
}

export function extraerBearer(cabecera: string | undefined): string | null {
  const partes = (cabecera ?? '').trim().split(/\s+/);
  return partes.length === 2 && /^bearer$/i.test(partes[0]) ? partes[1] : null;
}

// Carga útil SIN verificar la firma. Solo sirve para negar (un token con scope se rechaza sin importar si es válido);
// nunca para conceder nada.
export function cargaSinVerificar(token: string): Record<string, unknown> | null {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  try {
    const carga = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    return carga !== null && typeof carga === 'object' && !Array.isArray(carga) ? (carga as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function traeScope(token: string): boolean {
  const carga = cargaSinVerificar(token);
  return carga !== null && (carga.scope !== undefined || carga.scp !== undefined);
}

export function ahoraDePrueba(cabecera: string | undefined, env: NodeJS.ProcessEnv = process.env): Date | undefined {
  if (env.V2_CABECERAS_PRUEBA?.trim().toLowerCase() !== 'true' || !cabecera?.trim()) return undefined;
  const ms = Date.parse(cabecera.trim());
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

export interface ClavesJwt {
  /** Pide a usuarios su clave pública (o null si no tiene par RSA). Se inyecta para poder probarlo sin red. */
  obtenerClaveRemota?: () => Promise<string | null>;
}

export class VerificadorSesion {
  private readonly jwt = new JwtService();
  private claveRemota: { valor: string | null; hasta: number } | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly claves: ClavesJwt = {},
  ) {}

  private async resolverClave(): Promise<{ modo: 'rs256'; clave: string } | { modo: 'hs256'; clave: string } | null> {
    const publica = normalizarPem(this.env.JWT_PUBLIC_KEY);
    if (publica) return { modo: 'rs256', clave: publica };
    if (this.claves.obtenerClaveRemota) {
      const ahora = Date.now();
      if (!this.claveRemota || this.claveRemota.hasta < ahora) {
        let valor: string | null = null;
        try {
          valor = await this.claves.obtenerClaveRemota();
        } catch {
          valor = null;
        }
        // Una clave RSA no cambia a menudo; la ausencia se reintenta pronto
        this.claveRemota = { valor, hasta: ahora + (valor ? 300_000 : 5_000) };
      }
      if (this.claveRemota.valor) return { modo: 'rs256', clave: this.claveRemota.valor };
    }
    const secreto = this.env.JWT_SECRET?.trim();
    if (secreto && secreto.length >= 32) return { modo: 'hs256', clave: secreto };
    return null;
  }

  // null si el token no sirve (firma, vencimiento, forma). No distingue el motivo: no se le cuenta a quien lo prueba.
  async verificar(token: string, ahora?: Date): Promise<Sesion | null> {
    const config = await this.resolverClave();
    if (!config) return null;
    const emisor = this.env.JWT_ISSUER?.trim() || undefined;
    const audiencia = this.env.JWT_AUDIENCE?.trim() || undefined;
    let carga: { sub?: unknown; rol?: unknown; estado?: unknown };
    try {
      carga = await this.jwt.verifyAsync(token, {
        ...(config.modo === 'rs256' ? { publicKey: config.clave, algorithms: ['RS256'] } : { secret: config.clave, algorithms: ['HS256'] }),
        ...(emisor && { issuer: emisor }),
        ...(audiencia && { audience: audiencia }),
        ...(ahora && { clockTimestamp: Math.floor(ahora.getTime() / 1000) }),
      });
    } catch {
      return null;
    }
    if (
      typeof carga?.sub !== 'string' ||
      !ES_UUID.test(carga.sub) ||
      !ROLES.includes(carga.rol as RolSesion) ||
      !ESTADOS.includes(carga.estado as EstadoSesion)
    ) {
      return null;
    }
    return { id: carga.sub, rol: carga.rol as RolSesion, estado: carga.estado as EstadoSesion };
  }
}

// Control temprano por operación (columna «Acceso» de §9). Sin llamar a ningún servicio:
//   publico / opcional   siempre pasa (con `opcional`, un token válido se reenvía y el servicio asocia la cuenta)
//   sesion               token válido y de una cuenta activa, si no UNAUTHORIZED (ACCOUNT_* si la cuenta no está activa)
//   admin / superadmin   además el rol: si no alcanza, FORBIDDEN
export function exigirAcceso(acceso: Acceso, sesion: Sesion | null, conCredencial: boolean): void {
  if (acceso === 'publico' || acceso === 'opcional') return;
  if (!sesion) {
    throw errorPropio(
      401,
      'UNAUTHORIZED',
      conCredencial ? 'El token no es válido o venció: inicia sesión de nuevo' : 'Esta operación exige iniciar sesión',
    );
  }
  if (sesion.estado === 'pendiente') {
    throw errorPropio(403, 'ACCOUNT_PENDING', 'Tu cuenta de administrador está pendiente de aprobación por el superadmin');
  }
  if (sesion.estado === 'suspendido') throw errorPropio(403, 'ACCOUNT_SUSPENDED', 'Tu cuenta está suspendida');
  if (!ROLES_POR_ACCESO[acceso].includes(sesion.rol)) {
    throw errorPropio(403, 'FORBIDDEN', 'Tu rol no tiene permiso para esta operación');
  }
}

