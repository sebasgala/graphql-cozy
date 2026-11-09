import { randomUUID } from 'crypto';
import { GraphQLError } from 'graphql';
import { errorDeServicio, errorPropio } from './problemas';
import { Sesion } from './seguridad';

export type Servicio = 'usuarios' | 'catalogo' | 'disponibilidad' | 'reservas';

const PUERTOS_POR_DEFECTO: Record<Servicio, number> = { usuarios: 3001, catalogo: 3002, disponibilidad: 3003, reservas: 3004 };
const VARIABLE_URL: Record<Servicio, string> = {
  usuarios: 'USUARIOS_URL',
  catalogo: 'CATALOGO_URL',
  disponibilidad: 'DISPONIBILIDAD_URL',
  reservas: 'RESERVAS_URL',
};

// Plazo por llamada: 8 s, menor que el del gateway (10 s), para que graphql responda un error ordenado antes de que el
// gateway corte con 504 (§9). GRAPHQL_TIMEOUT_MS solo lo cambia en pruebas.
export const PLAZO_POR_DEFECTO_MS = 8000;

export function plazoMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GRAPHQL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : PLAZO_POR_DEFECTO_MS;
}

// Mismo esquema que resolverUrlServicio del gateway: la variable del servicio, o BACKEND_URL, o su puerto por defecto.
export function urlServicio(servicio: Servicio, env: NodeJS.ProcessEnv = process.env): string {
  const explicita = env[VARIABLE_URL[servicio]]?.trim() || env.BACKEND_URL?.trim();
  return (explicita || `http://localhost:${PUERTOS_POR_DEFECTO[servicio]}`).replace(/\/+$/, '');
}

export interface ContextoGraphql {
  env: NodeJS.ProcessEnv;
  correlationId: string;
  /** Authorization tal como llegó (se reenvía sin tocar) */
  authorization?: string;
  /** Hay un Bearer en la petición (válido o no) */
  conCredencial: boolean;
  /** Sesión del token si era válido; null si no hay token o no sirve */
  sesion: Sesion | null;
  /** X-Forwarded-For que se reenvía a los servicios: la IP del navegador, para los límites por IP */
  xForwardedFor?: string;
  deviceFingerprint?: string;
  /** Cabeceras de reloj de pruebas (solo con V2_CABECERAS_PRUEBA=true) */
  pruebas: Record<string, string>;
  alojamientos: LoteAlojamientos;
  /** Llamadas hechas a servicios en esta petición (para pruebas y registros) */
  llamadas: number;
}

export interface Llamada {
  servicio: Servicio;
  metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Ruta v1 sin el prefijo /api/v1 */
  ruta: string;
  consulta?: Record<string, unknown>;
  cuerpo?: unknown;
  idempotencyKey?: string;
}

export function seg(valor: string | number): string {
  return encodeURIComponent(String(valor));
}

function cadenaDeConsulta(consulta: Record<string, unknown> | undefined): string {
  if (!consulta) return '';
  const partes: string[] = [];
  for (const [clave, valor] of Object.entries(consulta)) {
    if (valor === undefined || valor === null) continue;
    partes.push(`${encodeURIComponent(clave)}=${encodeURIComponent(String(valor))}`);
  }
  return partes.length ? `?${partes.join('&')}` : '';
}

function cabecerasDe(ctx: ContextoGraphql, llamada: Llamada): Record<string, string> {
  return {
    accept: 'application/json',
    'x-correlation-id': ctx.correlationId,
    ...(llamada.cuerpo !== undefined && { 'content-type': 'application/json' }),
    // Cada servicio vuelve a verificar el token: nadie confía en una cabecera puesta por otro (§5 y §9)
    ...(ctx.authorization && { authorization: ctx.authorization }),
    ...(ctx.xForwardedFor && { 'x-forwarded-for': ctx.xForwardedFor }),
    ...(ctx.deviceFingerprint && { 'x-device-fingerprint': ctx.deviceFingerprint }),
    ...(llamada.idempotencyKey && { 'idempotency-key': llamada.idempotencyKey }),
    ...ctx.pruebas,
  };
}

// Llama directo al servicio dueño (sin pasar por el gateway: evita el salto doble y el bucle /graphql → gateway → /graphql).
export async function llamarServicio<T = any>(ctx: ContextoGraphql, llamada: Llamada): Promise<T> {
  const url = `${urlServicio(llamada.servicio, ctx.env)}/api/v1${llamada.ruta}${cadenaDeConsulta(llamada.consulta)}`;
  ctx.llamadas++;
  let respuesta: Response;
  try {
    respuesta = await fetch(url, {
      method: llamada.metodo,
      headers: cabecerasDe(ctx, llamada),
      body: llamada.cuerpo === undefined ? undefined : JSON.stringify(llamada.cuerpo),
      redirect: 'manual',
      signal: AbortSignal.timeout(plazoMs(ctx.env)),
    });
  } catch (error) {
    const nombre = (error as Error)?.name ?? '';
    if (nombre === 'TimeoutError' || nombre === 'AbortError') {
      throw errorPropio(504, 'GATEWAY_TIMEOUT', `El servicio ${llamada.servicio} no respondió a tiempo.`, { servicio: llamada.servicio });
    }
    throw errorPropio(502, 'INTERNAL_ERROR', `No se pudo conectar con el servicio ${llamada.servicio}.`, { servicio: llamada.servicio });
  }

  let texto = '';
  try {
    texto = respuesta.status === 204 ? '' : await respuesta.text();
  } catch (error) {
    const nombre = (error as Error)?.name ?? '';
    if (nombre === 'TimeoutError' || nombre === 'AbortError') {
      throw errorPropio(504, 'GATEWAY_TIMEOUT', `El servicio ${llamada.servicio} no respondió a tiempo.`, { servicio: llamada.servicio });
    }
    throw errorPropio(502, 'INTERNAL_ERROR', `Se cortó la respuesta del servicio ${llamada.servicio}.`, { servicio: llamada.servicio });
  }
  let cuerpo: unknown = undefined;
  if (texto) {
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      cuerpo = undefined;
    }
  }
  if (!respuesta.ok) {
    const cabeceraReintento = respuesta.headers.get('retry-after');
    const reintento = cabeceraReintento ? Number(cabeceraReintento) : NaN;
    throw errorDeServicio(llamada.servicio, respuesta.status, cuerpo, Number.isFinite(reintento) ? reintento : undefined);
  }
  return cuerpo as T;
}

export function nuevaClaveDeIdempotencia(): string {
  return randomUUID();
}

// Fichas de alojamiento en lote: una sola petición a catalogo (POST /details) por todos los ids que se piden en la misma
// petición GraphQL, y cada id una sola vez. Sin caché entre peticiones: el lote vive y muere con su contexto (§9).
export class LoteAlojamientos {
  private readonly cache = new Map<number, Promise<any | null>>();
  private pendientes = new Map<number, { resolver: (v: any | null) => void; rechazar: (e: unknown) => void }>();
  private programado = false;
  /** Cuántas peticiones a /details hizo este lote (lo leen las pruebas) */
  peticiones = 0;

  constructor(private readonly contexto: () => ContextoGraphql) {}

  cargar(id: number): Promise<any | null> {
    const existente = this.cache.get(id);
    if (existente) return existente;
    const promesa = new Promise<any | null>((resolver, rechazar) => {
      this.pendientes.set(id, { resolver, rechazar });
    });
    this.cache.set(id, promesa);
    if (!this.programado) {
      this.programado = true;
      // Después de que graphql-js termine de pedir todos los campos del mismo nivel
      setImmediate(() => void this.vaciar());
    }
    return promesa;
  }

  private async detalles(ids: number[]): Promise<any[]> {
    this.peticiones++;
    const r = await llamarServicio<{ data: any[] }>(this.contexto(), {
      servicio: 'catalogo',
      metodo: 'POST',
      ruta: '/details',
      cuerpo: { accommodations: ids },
    });
    return r?.data ?? [];
  }

  private async vaciar(): Promise<void> {
    const lote = this.pendientes;
    this.pendientes = new Map();
    this.programado = false;
    const ids = [...lote.keys()];
    try {
      const datos = await this.detalles(ids);
      for (const [id, p] of lote) p.resolver(datos.find((a) => a.id === id) ?? null);
    } catch (error) {
      // /details responde 404 si UN id no existe o está inactivo: se piden uno por uno, cada uno una vez
      const noExiste = error instanceof GraphQLError && error.extensions?.status === 404;
      if (!noExiste || ids.length === 1) {
        for (const p of lote.values()) {
          if (noExiste) p.resolver(null);
          else p.rechazar(error);
        }
        return;
      }
      await Promise.all(
        ids.map(async (id) => {
          const p = lote.get(id)!;
          try {
            p.resolver((await this.detalles([id])).find((a) => a.id === id) ?? null);
          } catch (e) {
            if (e instanceof GraphQLError && e.extensions?.status === 404) p.resolver(null);
            else p.rechazar(e);
          }
        }),
      );
    }
  }
}
