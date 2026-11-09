import { GraphQLError } from 'graphql';

// Errores de graphql. Los suyos propios son UNAUTHORIZED, FORBIDDEN, VALIDATION_FAILED (consulta mal formada),
// GATEWAY_TIMEOUT e INTERNAL_ERROR (servicio caído o fallo inesperado). Los de un servicio pasan con su ProblemDetails
// original en `extensions`, sin reescribirlo (§9 del diseño).
//
// Deuda declarada (§9, «@cozy/comun»): los códigos y la correspondencia estado → código son una copia a mano de los del
// backend y del gateway (gateway-esb/src/problemas.ts); su prueba (graphql.spec.ts) los comprueba.

export type CodigoPropio =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'ACCOUNT_PENDING'
  | 'ACCOUNT_SUSPENDED'
  | 'VALIDATION_FAILED'
  | 'GATEWAY_TIMEOUT'
  | 'INTERNAL_ERROR';

const CODIGO_POR_ESTADO: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMIT_EXCEEDED',
  504: 'GATEWAY_TIMEOUT',
};

export function codigoPorEstado(estado: number): string {
  return CODIGO_POR_ESTADO[estado] ?? (estado >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');
}

export function errorPropio(estado: number, codigo: CodigoPropio, detalle: string, extras: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(detalle, { extensions: { code: codigo, status: estado, detail: detalle, ...extras } });
}

// Respuesta de error de un servicio: el cuerpo (ProblemDetails) viaja entero en `problem` y sus campos principales se copian
// a `extensions` tal cual. Si el cuerpo no es un ProblemDetails (por ejemplo, un proxy devolvió HTML), se arma el mínimo.
export function errorDeServicio(servicio: string, estado: number, cuerpo: unknown, retryAfter: number | undefined): GraphQLError {
  const problema = cuerpo !== null && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? (cuerpo as Record<string, unknown>) : null;
  const codigo = typeof problema?.code === 'string' ? problema.code : codigoPorEstado(estado);
  const detalle =
    (typeof problema?.detail === 'string' && problema.detail) ||
    (typeof problema?.message === 'string' && problema.message) ||
    (typeof problema?.title === 'string' && problema.title) ||
    `El servicio ${servicio} respondió ${estado}.`;
  return new GraphQLError(detalle, {
    extensions: {
      code: codigo,
      status: typeof problema?.status === 'number' ? problema.status : estado,
      detail: detalle,
      ...(typeof problema?.instance === 'string' && { instance: problema.instance }),
      ...(typeof problema?.title === 'string' && { title: problema.title }),
      ...(Array.isArray(problema?.invalidParams) && { invalidParams: problema.invalidParams }),
      ...(Array.isArray(problema?.invalid_params) && { invalid_params: problema.invalid_params }),
      ...(retryAfter !== undefined && { retryAfter }),
      servicio,
      problem: problema,
    },
  });
}

// Lo que se entrega al cliente: todo error lleva `code` y `status`. Un fallo que no controlamos nunca filtra su mensaje.
export function normalizarError(error: GraphQLError): GraphQLError {
  if (typeof error.extensions?.code === 'string') return error;
  // Con `originalError` es una excepción nuestra no prevista; sin ella, graphql-js rechazó la consulta (sintaxis, validación
  // contra el esquema, variables mal tipadas)
  if (error.originalError) {
    return new GraphQLError('graphql tuvo un problema inesperado.', {
      path: error.path,
      nodes: error.nodes,
      extensions: { code: 'INTERNAL_ERROR', status: 500, detail: 'graphql tuvo un problema inesperado.' },
    });
  }
  return new GraphQLError(error.message, {
    path: error.path,
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    extensions: { code: 'VALIDATION_FAILED', status: 400, detail: error.message },
  });
}

