import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildSchema, GraphQLError, graphql, GraphQLSchema, Kind, parse } from 'graphql';
import { errorPropio, normalizarError } from './problemas';
import { instalarResolutores } from './resolutores';
import { ahoraDePrueba, extraerBearer, traeScope, VerificadorSesion } from './seguridad';
import { ContextoGraphql, LoteAlojamientos, llamarServicio } from './servicios';

export const PATRON_CORRELACION = /^[A-Za-z0-9._:-]{4,64}$/;
// Cada operación raíz es una llamada a un servicio: se acota para que una sola petición no se multiplique sin límite
export const MAX_OPERACIONES_POR_PETICION = 25;
export const MAX_BYTES_CONSULTA = 100_000;

export interface PeticionEntrada {
  metodo: string;
  cuerpo?: string;
  cabeceras: Record<string, string | undefined>;
  direccionRemota?: string;
}

export interface RespuestaSalida {
  estado: number;
  cabeceras: Record<string, string>;
  cuerpo: { data?: unknown; errors?: unknown[] };
}

export function cargarEsquema(ruta = resolve(__dirname, '..', 'schema.graphql')): GraphQLSchema {
  const schema = buildSchema(readFileSync(ruta, 'utf8'));
  instalarResolutores(schema);
  return schema;
}

// Nombres de las operaciones raíz que pide la consulta (solo nombres de campo, nunca argumentos ni variables: los logs no
// llevan datos personales)
function operacionesRaiz(source: string): string[] | null {
  try {
    const nombres: string[] = [];
    for (const definicion of parse(source).definitions) {
      if (definicion.kind !== Kind.OPERATION_DEFINITION) continue;
      for (const sel of definicion.selectionSet.selections) {
        if (sel.kind === Kind.FIELD) nombres.push(sel.name.value);
        else nombres.push('…');
      }
    }
    return nombres;
  } catch {
    return null;
  }
}

function direccionDelNavegador(cabeceras: Record<string, string | undefined>, remota: string | undefined): string | undefined {
  const entrante = cabeceras['x-forwarded-for']?.trim();
  // Lo que ya trae la cadena (gateway o proxy) se respeta tal cual: así el límite por IP de los servicios cuenta la del
  // navegador. Sin cadena, la única dirección conocida es la del par que se conectó.
  if (entrante) return entrante.slice(0, 300);
  return remota ? remota.replace(/^::ffff:/, '') : undefined;
}

export interface OpcionesServidor {
  env?: NodeJS.ProcessEnv;
  schema?: GraphQLSchema;
  registrar?: (linea: Record<string, unknown>) => void;
}

export class ServidorGraphql {
  readonly schema: GraphQLSchema;
  private readonly env: NodeJS.ProcessEnv;
  private readonly verificador: VerificadorSesion;
  private readonly registrar: (linea: Record<string, unknown>) => void;

  constructor(opciones: OpcionesServidor = {}) {
    this.env = opciones.env ?? process.env;
    this.schema = opciones.schema ?? cargarEsquema();
    this.registrar =
      opciones.registrar ??
      ((linea) => {
        process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), modulo: 'graphql', ...linea })}\n`);
      });
    this.verificador = new VerificadorSesion(this.env, {
      // La clave pública que publica usuarios (D3); sin par RSA responde null y se usa JWT_SECRET solo en pruebas
      obtenerClaveRemota: async () => {
        const contexto = this.contextoSinSesion(randomUUID());
        const r = await llamarServicio<{ publicKey?: string | null }>(contexto, {
          servicio: 'usuarios',
          metodo: 'GET',
          ruta: '/interno/usuarios/clave-publica',
        });
        return typeof r?.publicKey === 'string' && r.publicKey ? r.publicKey : null;
      },
    });
  }

  private contextoSinSesion(correlationId: string): ContextoGraphql {
    const ctx: ContextoGraphql = {
      env: this.env,
      correlationId,
      conCredencial: false,
      sesion: null,
      pruebas: {},
      alojamientos: undefined as unknown as LoteAlojamientos,
      llamadas: 0,
    };
    ctx.alojamientos = new LoteAlojamientos(() => ctx);
    return ctx;
  }

  async ejecutar(p: PeticionEntrada): Promise<RespuestaSalida> {
    const inicio = process.hrtime.bigint();
    const entrante = p.cabeceras['x-correlation-id'];
    const correlationId = entrante && PATRON_CORRELACION.test(entrante) ? entrante : randomUUID();
    const respuesta = (cuerpo: RespuestaSalida['cuerpo']): RespuestaSalida => ({
      estado: 200,
      cabeceras: { 'X-Correlation-ID': correlationId },
      cuerpo,
    });
    let operaciones: string[] | null = null;
    let contexto: ContextoGraphql | null = null;
    const terminar = (resultado: RespuestaSalida): RespuestaSalida => {
      const codigos = (resultado.cuerpo.errors ?? []).map((e) => (e as { extensions?: { code?: string } }).extensions?.code ?? 'INTERNAL_ERROR');
      this.registrar({
        nivel: codigos.length ? 'warn' : 'info',
        evento: 'graphql',
        metodo: p.metodo,
        ruta: '/graphql',
        estado: resultado.estado,
        operaciones: operaciones ?? [],
        errores: codigos,
        llamadas: contexto?.llamadas ?? 0,
        ms: Math.round(Number(process.hrtime.bigint() - inicio) / 1e5) / 10,
        correlationId,
      });
      return resultado;
    };
    const falla = (e: GraphQLError) => terminar(respuesta({ errors: [e.toJSON()] }));

    // 1. Un token con scope (OAuth de servicio, como el de Booking) rechaza TODA la petición, aunque pida solo operaciones
    //    públicas, y no se llama a ningún servicio. Se decide antes de leer el cuerpo.
    const token = extraerBearer(p.cabeceras.authorization);
    if (token && traeScope(token)) {
      return falla(errorPropio(403, 'FORBIDDEN', '/graphql es solo de la UI: un token con scope no puede usarse aquí (Booking usa su REST v2).'));
    }

    // 2. Cuerpo
    if (p.metodo.toUpperCase() !== 'POST') {
      return falla(errorPropio(400, 'VALIDATION_FAILED', 'Las operaciones se envían con POST /graphql.'));
    }
    if (typeof p.cuerpo !== 'string' || p.cuerpo.length === 0) {
      return falla(errorPropio(400, 'VALIDATION_FAILED', 'Falta el cuerpo JSON con la consulta (query).'));
    }
    if (p.cuerpo.length > MAX_BYTES_CONSULTA) {
      return falla(errorPropio(400, 'VALIDATION_FAILED', 'La petición es demasiado grande.'));
    }
    let entrada: any;
    try {
      entrada = JSON.parse(p.cuerpo);
    } catch {
      return falla(errorPropio(400, 'VALIDATION_FAILED', 'El cuerpo no es JSON válido.'));
    }
    if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada) || typeof entrada.query !== 'string' || entrada.query.trim() === '') {
      return falla(errorPropio(400, 'VALIDATION_FAILED', 'El cuerpo debe ser un objeto JSON con la consulta en `query`.'));
    }
    if (entrada.variables != null && (typeof entrada.variables !== 'object' || Array.isArray(entrada.variables))) {
      return falla(errorPropio(400, 'VALIDATION_FAILED', '`variables` debe ser un objeto.'));
    }
    if (entrada.operationName != null && typeof entrada.operationName !== 'string') {
      return falla(errorPropio(400, 'VALIDATION_FAILED', '`operationName` debe ser texto.'));
    }
    operaciones = operacionesRaiz(entrada.query);
    if (operaciones && operaciones.length > MAX_OPERACIONES_POR_PETICION) {
      return falla(errorPropio(400, 'VALIDATION_FAILED', `Una petición admite como máximo ${MAX_OPERACIONES_POR_PETICION} operaciones.`));
    }

    // 3. Quién es: el token se verifica con la clave pública. Un token que no sirve no rompe las operaciones públicas
    //    (como en la v1); las protegidas responderán UNAUTHORIZED sin llamar a nadie.
    const sesion = token ? await this.verificador.verificar(token, ahoraDePrueba(p.cabeceras['x-prueba-token-ahora'], this.env)) : null;
    contexto = this.contextoSinSesion(correlationId);
    contexto.authorization = p.cabeceras.authorization;
    contexto.conCredencial = Boolean(token);
    contexto.sesion = sesion;
    contexto.xForwardedFor = direccionDelNavegador(p.cabeceras, p.direccionRemota);
    contexto.deviceFingerprint = p.cabeceras['x-device-fingerprint']?.slice(0, 200);
    if (this.env.V2_CABECERAS_PRUEBA?.trim().toLowerCase() === 'true') {
      for (const nombre of ['x-prueba-ahora', 'x-prueba-token-ahora', 'x-prueba-retraso-ms']) {
        const valor = p.cabeceras[nombre];
        if (valor !== undefined) contexto.pruebas[nombre] = valor;
      }
    }

    // 4. Ejecutar
    let resultado;
    try {
      resultado = await graphql({
        schema: this.schema,
        source: entrada.query,
        variableValues: entrada.variables ?? undefined,
        operationName: entrada.operationName ?? undefined,
        contextValue: contexto,
      });
    } catch {
      return falla(errorPropio(500, 'INTERNAL_ERROR', 'graphql tuvo un problema inesperado.'));
    }
    const cuerpo: RespuestaSalida['cuerpo'] = {};
    if (resultado.errors?.length) cuerpo.errors = resultado.errors.map((e) => normalizarError(e).toJSON());
    if (resultado.data !== undefined) cuerpo.data = resultado.data;
    return terminar(respuesta(cuerpo));
  }
}

