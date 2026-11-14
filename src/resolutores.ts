import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { Acceso, exigirAcceso } from './seguridad';
import { ContextoGraphql, llamarServicio, nuevaClaveDeIdempotencia, seg } from './servicios';

// Las 37 operaciones de §3 (17 consultas y 20 mutaciones) más las 9 de recepción del Bloque R. Cada resolver:
//   1. aplica el control temprano de la columna «Acceso» de §9 (sin llamar a nadie si no pasa);
//   2. llama directo a la ruta v1 del servicio dueño, reenviando el Authorization original.
// La regla final la sigue poniendo cada servicio.

type Argumentos = Record<string, any>;
type Resolutor = (args: Argumentos, ctx: ContextoGraphql) => Promise<unknown>;

interface Operacion {
  tipo: 'Query' | 'Mutation';
  acceso: Acceso;
  resolver: Resolutor;
}

// Lo que hoy hace la UI al armar el cuerpo de /search y /availability
const BOOKER_POR_DEFECTO = { country: 'ec', platform: 'desktop' };
const CONCURRENCIA_DISPONIBILIDAD = 6;

async function conLimite<T, R>(items: T[], limite: number, tarea: (item: T) => Promise<R>): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      resultados[i] = await tarea(items[i]);
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}

const catalogo = (ctx: ContextoGraphql, metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, extra: { consulta?: Record<string, unknown>; cuerpo?: unknown } = {}) =>
  llamarServicio(ctx, { servicio: 'catalogo', metodo, ruta, ...extra });
const disponibilidad = (ctx: ContextoGraphql, metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, extra: { consulta?: Record<string, unknown>; cuerpo?: unknown } = {}) =>
  llamarServicio(ctx, { servicio: 'disponibilidad', metodo, ruta, ...extra });
const reservas = (
  ctx: ContextoGraphql,
  metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  ruta: string,
  extra: { consulta?: Record<string, unknown>; cuerpo?: unknown; idempotencyKey?: string } = {},
) => llamarServicio(ctx, { servicio: 'reservas', metodo, ruta, ...extra });
const usuarios = (ctx: ContextoGraphql, metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, extra: { consulta?: Record<string, unknown>; cuerpo?: unknown } = {}) =>
  llamarServicio(ctx, { servicio: 'usuarios', metodo, ruta, ...extra });

export const OPERACIONES: Record<string, Operacion> = {
  // ───────────────────────── Catálogo ─────────────────────────
  alojamientos: {
    tipo: 'Query',
    acceso: 'publico',
    resolver: async (a, c) => ((await catalogo(c, 'POST', '/details', { cuerpo: a.filtro ?? {} })) as any).data,
  },
  alojamiento: {
    tipo: 'Query',
    acceso: 'publico',
    resolver: async (a, c) => ((await catalogo(c, 'POST', '/details', { cuerpo: { accommodations: [a.id] } })) as any).data?.find((x: any) => x.id === a.id) ?? null,
  },
  buscarAlojamientos: {
    tipo: 'Query',
    acceso: 'publico',
    resolver: async (a, c) => {
      const k = a.criterio;
      const booker = k.booker ?? BOOKER_POR_DEFECTO;
      const busqueda: any = await catalogo(c, 'POST', '/search', {
        cuerpo: {
          booker,
          checkin: k.checkin,
          checkout: k.checkout,
          guests: k.guests,
          ...(k.city != null && { city: k.city }),
          ...(k.country != null && { country: k.country }),
          ...(k.extras != null && { extras: k.extras }),
          ...(k.currency != null && { currency: k.currency }),
          ...(k.rows != null && { rows: k.rows }),
          ...(k.page != null && { page: k.page }),
        },
      });
      const ids: number[] = (busqueda.data ?? []).map((i: { id: number }) => i.id);
      if (ids.length === 0) return { data: [], next_page: busqueda.next_page ?? null };
      // Fichas en bloque y, en paralelo, el precio real de cada alojamiento para estas fechas: el «desde» es la habitación
      // disponible más barata, no el precio base del catálogo (igual que hace la UI hoy)
      const [fichas, disponibles] = await Promise.all([
        catalogo(c, 'POST', '/details', { cuerpo: { accommodations: ids } }) as Promise<any>,
        conLimite(ids, CONCURRENCIA_DISPONIBILIDAD, (id) =>
          (catalogo(c, 'POST', '/availability', {
            cuerpo: {
              accommodation: id,
              booker,
              checkin: k.checkin,
              checkout: k.checkout,
              guests: k.guests,
              ...(k.currency != null && { currency: k.currency }),
            },
          }) as Promise<any>)
            .then((r) => r.data)
            // Un alojamiento sin precio para esas fechas no se ofrece (como hoy: si se agotó entre /search y /availability)
            .catch(() => null),
        ),
      ]);
      const porId = new Map<number, any>(ids.map((id, i) => [id, disponibles[i]]));
      const data = (fichas.data ?? [])
        .map((alojamiento: any) => ({ alojamiento, disponibilidad: porId.get(alojamiento.id) }))
        .filter((x: any) => x.disponibilidad && x.disponibilidad.products?.length > 0)
        .map((x: any) => ({
          ...x,
          precioEstancia: Math.round(Math.min(...x.disponibilidad.products.map((p: any) => p.price.total)) * k.guests.number_of_rooms * 100) / 100,
        }));
      return { data, next_page: busqueda.next_page ?? null };
    },
  },
  disponibilidad: {
    tipo: 'Query',
    acceso: 'publico',
    resolver: async (a, c) =>
      (
        (await catalogo(c, 'POST', '/availability', {
          cuerpo: {
            accommodation: a.alojamientoId,
            booker: a.booker ?? BOOKER_POR_DEFECTO,
            checkin: a.checkin,
            checkout: a.checkout,
            guests: a.guests,
            ...(a.currency != null && { currency: a.currency }),
            ...(a.extras != null && { extras: a.extras }),
          },
        })) as any
      ).data,
  },
  alojamientosAdmin: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => catalogo(c, 'GET', '/admin/alojamientos', { consulta: a.filtro ?? {} }),
  },
  alojamientoAdmin: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => catalogo(c, 'GET', `/admin/alojamientos/${seg(a.id)}`, { consulta: { incluirInactivas: a.incluirInactivas } }),
  },
  crearAlojamiento: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'POST', '/admin/alojamientos', { cuerpo: a.datos }),
  },
  actualizarAlojamiento: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'PATCH', `/admin/alojamientos/${seg(a.id)}`, { cuerpo: a.datos }),
  },
  eliminarAlojamiento: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: async (a, c) => {
      await catalogo(c, 'DELETE', `/admin/alojamientos/${seg(a.id)}`);
      return true;
    },
  },
  ciudades: {
    tipo: 'Query',
    acceso: 'admin',
    resolver: (_a, c) => catalogo(c, 'GET', '/admin/ciudades'),
  },
  crearCiudad: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'POST', '/admin/ciudades', { cuerpo: a.datos }),
  },
  habitaciones: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => catalogo(c, 'GET', `/admin/alojamientos/${seg(a.alojamientoId)}/habitaciones`, { consulta: { incluirInactivas: a.incluirInactivas || undefined } }),
  },
  habitacion: {
    tipo: 'Query',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'GET', `/admin/habitaciones/${seg(a.id)}`),
  },
  crearHabitacion: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'POST', `/admin/alojamientos/${seg(a.alojamientoId)}/habitaciones`, { cuerpo: a.datos }),
  },
  actualizarHabitacion: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'PATCH', `/admin/habitaciones/${seg(a.id)}`, { cuerpo: a.datos }),
  },
  desactivarHabitacion: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'POST', `/admin/habitaciones/${seg(a.id)}/desactivar`),
  },
  reactivarHabitacion: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => catalogo(c, 'POST', `/admin/habitaciones/${seg(a.id)}/reactivar`),
  },

  // ───────────────────────── Disponibilidad ─────────────────────────
  disponibilidadAdmin: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => disponibilidad(c, 'GET', `/admin/habitaciones/${seg(a.habitacionId)}/disponibilidad`, { consulta: { desde: a.desde, hasta: a.hasta } }),
  },
  editarDisponibilidad: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => disponibilidad(c, 'PATCH', `/admin/habitaciones/${seg(a.habitacionId)}/disponibilidad`, { cuerpo: a.datos }),
  },

  // ───────────────────────── Reservas ─────────────────────────
  cotizarOrden: {
    tipo: 'Mutation',
    acceso: 'opcional',
    resolver: async (a, c) => ((await reservas(c, 'POST', '/orders/preview', { cuerpo: a.solicitud })) as any).data,
  },
  crearOrden: {
    tipo: 'Mutation',
    acceso: 'opcional',
    resolver: (a, c) => reservas(c, 'POST', '/orders/create', { cuerpo: a.solicitud, idempotencyKey: a.idempotencyKey }),
  },
  orden: {
    tipo: 'Query',
    acceso: 'opcional',
    resolver: (a, c) => reservas(c, 'GET', `/orders/${seg(a.id)}`),
  },
  cancelarOrden: {
    tipo: 'Mutation',
    acceso: 'opcional',
    resolver: (a, c) => reservas(c, 'POST', `/orders/${seg(a.id)}/cancel`, { idempotencyKey: a.idempotencyKey ?? nuevaClaveDeIdempotencia() }),
  },
  misReservas: {
    tipo: 'Query',
    acceso: 'sesion',
    resolver: (a, c) => reservas(c, 'GET', '/cuenta/reservas', { consulta: a.filtro ?? {} }),
  },
  miReserva: {
    tipo: 'Query',
    acceso: 'sesion',
    resolver: (a, c) => reservas(c, 'GET', `/cuenta/reservas/${seg(a.localizador)}`),
  },
  consultarReserva: {
    tipo: 'Query',
    acceso: 'publico',
    resolver: (a, c) => reservas(c, 'POST', '/cuenta/consultar-reserva', { cuerpo: { localizador: a.localizador, correo: a.correo } }),
  },
  reservasAdmin: {
    tipo: 'Query',
    acceso: 'admin',
    resolver: (a, c) => reservas(c, 'GET', '/admin/reservas', { consulta: a.filtro ?? {} }),
  },
  cancelarReservaAdmin: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => reservas(c, 'POST', `/admin/reservas/${seg(a.id)}/cancelar`),
  },

  // ───────────────────────── Recepción (Bloque R) ─────────────────────────
  contextoRecepcion: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (_a, c) => reservas(c, 'GET', '/admin/recepcion/contexto'),
  },
  reservasRecepcion: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'GET', '/admin/recepcion/reservas', { consulta: a.filtro ?? {} }),
  },
  habitacionesReasignables: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'GET', `/admin/recepcion/reservas/${seg(a.id)}/habitaciones`),
  },
  auditoriaRecepcion: {
    tipo: 'Query',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'GET', `/admin/recepcion/reservas/${seg(a.id)}/auditoria`),
  },
  aprobarCheckinRecepcion: {
    tipo: 'Mutation',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.id)}/checkin-aprobado`, { cuerpo: a.datos }),
  },
  reasignarHabitacionRecepcion: {
    tipo: 'Mutation',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.id)}/reasignar-habitacion`, { cuerpo: a.datos }),
  },
  cambiarHuespedesRecepcion: {
    tipo: 'Mutation',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.id)}/huespedes`, { cuerpo: a.datos }),
  },
  cambiarObservacionesRecepcion: {
    tipo: 'Mutation',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.id)}/observaciones`, { cuerpo: a.datos }),
  },
  autorizarEarlyCheckin: {
    tipo: 'Mutation',
    acceso: 'admin',
    resolver: (a, c) => reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.id)}/early-checkin`, { cuerpo: a.datos ?? {} }),
  },
  marcarLimpiezaLista: {
    tipo: 'Mutation',
    acceso: 'recepcion',
    resolver: (a, c) =>
      reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.reservaId)}/habitacion-limpia`, {
        cuerpo: {
          ...(a.habitacionFisicaId && { habitacionFisicaId: a.habitacionFisicaId }),
          ...(a.notas !== undefined && { notas: a.notas }),
        },
      }),
  },
  archivarReservaRecepcion: {
    tipo: 'Mutation',
    acceso: 'recepcion',
    resolver: (a, c) => reservas(c, 'POST', `/admin/recepcion/reservas/${seg(a.reservaId)}/archivar`, { cuerpo: {} }),
  },

  // ───────────────────────── Usuarios ─────────────────────────
  registrarse: {
    tipo: 'Mutation',
    acceso: 'publico',
    resolver: (a, c) => usuarios(c, 'POST', '/auth/registro', { cuerpo: a.datos }),
  },
  iniciarSesion: {
    tipo: 'Mutation',
    acceso: 'publico',
    resolver: (a, c) => usuarios(c, 'POST', '/auth/login', { cuerpo: { email: a.email, password: a.password } }),
  },
  renovarSesion: {
    tipo: 'Mutation',
    acceso: 'sesion',
    resolver: (_a, c) => usuarios(c, 'POST', '/auth/renovar'),
  },
  yo: {
    tipo: 'Query',
    acceso: 'sesion',
    resolver: (_a, c) => usuarios(c, 'GET', '/auth/me'),
  },
  usuariosAdmin: {
    tipo: 'Query',
    acceso: 'superadmin',
    resolver: (a, c) => usuarios(c, 'GET', '/admin/usuarios', { consulta: a.filtro ?? {} }),
  },
  crearUsuarioAdmin: {
    tipo: 'Mutation',
    acceso: 'superadmin',
    resolver: (a, c) => usuarios(c, 'POST', '/admin/usuarios', { cuerpo: a.datos }),
  },
  aprobarUsuario: {
    tipo: 'Mutation',
    acceso: 'superadmin',
    resolver: (a, c) => usuarios(c, 'POST', `/admin/usuarios/${seg(a.id)}/aprobar`),
  },
  suspenderUsuario: {
    tipo: 'Mutation',
    acceso: 'superadmin',
    resolver: (a, c) => usuarios(c, 'POST', `/admin/usuarios/${seg(a.id)}/suspender`),
  },
  reactivarUsuario: {
    tipo: 'Mutation',
    acceso: 'superadmin',
    resolver: (a, c) => usuarios(c, 'POST', `/admin/usuarios/${seg(a.id)}/reactivar`),
  },
  cambiarRolUsuario: {
    tipo: 'Mutation',
    acceso: 'superadmin',
    resolver: (a, c) =>
      usuarios(c, 'PATCH', `/admin/usuarios/${seg(a.id)}/rol`, {
        cuerpo: { rol: a.rol, ...(a.alojamientoId !== undefined && { alojamientoId: a.alojamientoId }) },
      }),
  },
};

// Conecta los resolutores al esquema (SDL) y falla al arrancar si el esquema y la tabla no coinciden: ninguna operación
// del contrato sin resolver, ninguna operación sin contrato.
export function instalarResolutores(schema: GraphQLSchema): void {
  for (const tipo of ['Query', 'Mutation'] as const) {
    const raiz = (tipo === 'Query' ? schema.getQueryType() : schema.getMutationType()) as GraphQLObjectType;
    const campos = raiz.getFields();
    const declaradas = Object.entries(OPERACIONES).filter(([, o]) => o.tipo === tipo).map(([n]) => n);
    for (const nombre of Object.keys(campos)) {
      if (!declaradas.includes(nombre)) throw new Error(`${tipo}.${nombre} está en schema.graphql y no tiene resolutor`);
    }
    for (const nombre of declaradas) {
      const campo = campos[nombre];
      if (!campo) throw new Error(`${tipo}.${nombre} tiene resolutor y no está en schema.graphql`);
      const operacion = OPERACIONES[nombre];
      campo.resolve = async (_fuente, args, ctx: ContextoGraphql) => {
        exigirAcceso(operacion.acceso, ctx.sesion, ctx.conCredencial);
        return operacion.resolver(args, ctx);
      };
    }
  }
  // Composición: el alojamiento de una orden lo trae catalogo, en lote
  for (const tipo of ['Orden', 'ReservaAdmin']) {
    const campo = (schema.getType(tipo) as GraphQLObjectType).getFields().alojamiento;
    campo.resolve = (orden: any, _args, ctx: ContextoGraphql) => ctx.alojamientos.cargar(orden.accommodation_details.accommodation_id);
  }
}

