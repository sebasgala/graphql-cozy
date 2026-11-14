import './registro-rutas';
import * as assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { errorPropio } from './problemas';
import { OPERACIONES } from './resolutores';
import { Acceso, exigirAcceso, ROLES_POR_ACCESO, Sesion, traeScope } from './seguridad';
import { cargarEsquema, ServidorGraphql } from './servidor';

describe('graphql (fase 9, paso 9.5a)', () => {
  const jwt = new JwtService();
  const parRsa = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const firmarToken = (carga: Record<string, unknown>, clavePrivada = parRsa.privateKey): string =>
    jwt.sign(carga, { privateKey: clavePrivada, algorithm: 'RS256' });

  it('1. schema.graphql tiene exactamente las 49 operaciones (§3 + 11 de recepción del Bloque R + crearUsuarioAdmin: 21 queries, 28 mutations)', () => {
    const schema = cargarEsquema();
    const queryFields = schema.getQueryType()?.getFields() ?? {};
    const mutationFields = schema.getMutationType()?.getFields() ?? {};

    const queries = Object.keys(queryFields);
    const mutations = Object.keys(mutationFields);

    assert.equal(queries.length, 21, `Esperadas 21 queries, encontradas ${queries.length}: ${queries.join(', ')}`);
    assert.equal(mutations.length, 28, `Esperadas 28 mutaciones, encontradas ${mutations.length}: ${mutations.join(', ')}`);
    assert.equal(Object.keys(OPERACIONES).length, 49, 'OPERACIONES debe registrar 49 resolutores');

    for (const [nombre, op] of Object.entries(OPERACIONES)) {
      if (op.tipo === 'Query') {
        assert.ok(queryFields[nombre], `Query.${nombre} no existe en schema`);
      } else {
        assert.ok(mutationFields[nombre], `Mutation.${nombre} no existe en schema`);
      }
    }
  });

  it('2. traeScope detecta tokens OAuth/servicio con scope o scp', () => {
    const tokenSinScope = jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', rol: 'cliente', estado: 'activo' }, { secret: 'secret' });
    const tokenConScope = jwt.sign({ sub: 'booking-client', scope: 'alojamientos:read' }, { secret: 'secret' });
    const tokenConScp = jwt.sign({ sub: 'booking-client', scp: ['alojamientos:book'] }, { secret: 'secret' });

    assert.equal(traeScope(tokenSinScope), false);
    assert.equal(traeScope(tokenConScope), true);
    assert.equal(traeScope(tokenConScp), true);
    assert.equal(traeScope('token-invalido'), false);
  });

  it('3. exigirAcceso valida roles y estados de cuenta según §9', () => {
    // Público y opcional pasan sin credenciales
    assert.doesNotThrow(() => exigirAcceso('publico', null, false));
    assert.doesNotThrow(() => exigirAcceso('opcional', null, false));

    // Sesión requerida sin token lanza UNAUTHORIZED (401)
    assert.throws(
      () => exigirAcceso('sesion', null, false),
      (err: any) => err.extensions?.status === 401 && err.extensions?.code === 'UNAUTHORIZED',
    );

    const sesionCliente: Sesion = { id: '11111111-1111-1111-1111-111111111111', rol: 'cliente', estado: 'activo' };
    const sesionAdmin: Sesion = { id: '22222222-2222-2222-2222-222222222222', rol: 'administrador', estado: 'activo' };
    const sesionSuperadmin: Sesion = { id: '33333333-3333-3333-3333-333333333333', rol: 'superadmin', estado: 'activo' };

    // Acceso sesión pasa para cualquiera activo
    assert.doesNotThrow(() => exigirAcceso('sesion', sesionCliente, true));

    // Acceso admin falla para cliente (403 FORBIDDEN), pasa para admin y superadmin
    assert.throws(
      () => exigirAcceso('admin', sesionCliente, true),
      (err: any) => err.extensions?.status === 403 && err.extensions?.code === 'FORBIDDEN',
    );
    assert.doesNotThrow(() => exigirAcceso('admin', sesionAdmin, true));
    assert.doesNotThrow(() => exigirAcceso('admin', sesionSuperadmin, true));

    // Acceso superadmin falla para cliente y admin (403 FORBIDDEN), pasa para superadmin
    assert.throws(
      () => exigirAcceso('superadmin', sesionAdmin, true),
      (err: any) => err.extensions?.status === 403 && err.extensions?.code === 'FORBIDDEN',
    );
    assert.doesNotThrow(() => exigirAcceso('superadmin', sesionSuperadmin, true));

    // Bloque R: recepción entra a sus operaciones y nunca a las de administración (catálogo, precios) ni de usuarios
    const sesionRecepcion: Sesion = { id: '66666666-6666-6666-6666-666666666666', rol: 'recepcion', estado: 'activo' };
    assert.doesNotThrow(() => exigirAcceso('recepcion', sesionRecepcion, true));
    assert.doesNotThrow(() => exigirAcceso('recepcion', sesionAdmin, true));
    assert.doesNotThrow(() => exigirAcceso('sesion', sesionRecepcion, true));
    for (const acceso of ['admin', 'superadmin'] as const) {
      assert.throws(() => exigirAcceso(acceso, sesionRecepcion, true), (err: any) => err.extensions?.status === 403 && err.extensions?.code === 'FORBIDDEN');
    }
    assert.throws(() => exigirAcceso('recepcion', sesionCliente, true), (err: any) => err.extensions?.status === 403);
    for (const [nombre, op] of Object.entries(OPERACIONES)) {
      const esDeRecepcion = /Recepcion$|^habitacionesReasignables$/.test(nombre);
      if (esDeRecepcion) assert.equal(op.acceso, 'recepcion', `${nombre} debe ser de recepción`);
      if (['crearAlojamiento', 'editarDisponibilidad', 'actualizarHabitacion', 'aprobarUsuario', 'cambiarRolUsuario', 'autorizarEarlyCheckin'].includes(nombre)) {
        assert.ok(!ROLES_POR_ACCESO[op.acceso as 'admin']?.includes('recepcion'), `${nombre} no debe admitir recepción`);
      }
    }

    // Cuentas inactivas
    const sesionPendiente: Sesion = { id: '44444444-4444-4444-4444-444444444444', rol: 'administrador', estado: 'pendiente' };
    const sesionSuspendida: Sesion = { id: '55555555-5555-5555-5555-555555555555', rol: 'cliente', estado: 'suspendido' };

    assert.throws(
      () => exigirAcceso('sesion', sesionPendiente, true),
      (err: any) => err.extensions?.status === 403 && err.extensions?.code === 'ACCOUNT_PENDING',
    );
    assert.throws(
      () => exigirAcceso('sesion', sesionSuspendida, true),
      (err: any) => err.extensions?.status === 403 && err.extensions?.code === 'ACCOUNT_SUSPENDED',
    );
  });

  it('4. ServidorGraphql rechaza inmediatamente tokens con scope con FORBIDDEN (HTTP 200 con errors)', async () => {
    const servidor = new ServidorGraphql({
      env: { JWT_PUBLIC_KEY: parRsa.publicKey },
      registrar: () => {},
    });

    const tokenScope = firmarToken({ sub: 'booking-app', scope: 'alojamientos:read' });
    const respuesta = await servidor.ejecutar({
      metodo: 'POST',
      cabeceras: {
        authorization: `Bearer ${tokenScope}`,
        'content-type': 'application/json',
      },
      cuerpo: JSON.stringify({ query: 'query { alojamientos { id } }' }),
    });

    assert.equal(respuesta.estado, 200, 'GraphQL responde HTTP 200 siempre con errors en el cuerpo');
    assert.ok(respuesta.cuerpo.errors, 'Debe haber un array de errors');
    const err = (respuesta.cuerpo.errors as any[])[0];
    assert.equal(err.extensions?.status, 403);
    assert.equal(err.extensions?.code, 'FORBIDDEN');
    assert.match(err.message, /token con scope/i);
  });

  it('5. ServidorGraphql valida método HTTP y estructura JSON de entrada', async () => {
    const servidor = new ServidorGraphql({
      env: { JWT_PUBLIC_KEY: parRsa.publicKey },
      registrar: () => {},
    });

    // Método no POST
    const resGet = await servidor.ejecutar({
      metodo: 'GET',
      cabeceras: {},
      cuerpo: '',
    });
    assert.equal(resGet.estado, 200);
    assert.equal((resGet.cuerpo.errors as any[])[0].extensions?.code, 'VALIDATION_FAILED');

    // JSON inválido
    const resBadJson = await servidor.ejecutar({
      metodo: 'POST',
      cabeceras: {},
      cuerpo: '{ invalid json',
    });
    assert.equal((resBadJson.cuerpo.errors as any[])[0].extensions?.code, 'VALIDATION_FAILED');

    // Query vacío
    const resEmptyQuery = await servidor.ejecutar({
      metodo: 'POST',
      cabeceras: {},
      cuerpo: JSON.stringify({ query: '' }),
    });
    assert.equal((resEmptyQuery.cuerpo.errors as any[])[0].extensions?.code, 'VALIDATION_FAILED');
  });

  it('6. Operaciones protegidas devuelven UNAUTHORIZED / FORBIDDEN con extensions completas', async () => {
    const servidor = new ServidorGraphql({
      env: { JWT_PUBLIC_KEY: parRsa.publicKey },
      registrar: () => {},
    });

    // Query 'yo' exige 'sesion': sin credenciales
    const resSinToken = await servidor.ejecutar({
      metodo: 'POST',
      cabeceras: {},
      cuerpo: JSON.stringify({ query: 'query { yo { id rol } }' }),
    });

    assert.equal(resSinToken.estado, 200);
    const errSinToken = (resSinToken.cuerpo.errors as any[])[0];
    assert.equal(errSinToken.extensions?.status, 401);
    assert.equal(errSinToken.extensions?.code, 'UNAUTHORIZED');
    assert.ok(errSinToken.extensions?.detail);

    // Query 'usuariosAdmin' exige 'superadmin': cliente autenticado recibe FORBIDDEN
    const tokenCliente = firmarToken({
      sub: '11111111-1111-1111-1111-111111111111',
      rol: 'cliente',
      estado: 'activo',
    });

    const resForbidden = await servidor.ejecutar({
      metodo: 'POST',
      cabeceras: {
        authorization: `Bearer ${tokenCliente}`,
      },
      cuerpo: JSON.stringify({ query: 'query { usuariosAdmin { meta { totalItems } } }' }),
    });

    assert.equal(resForbidden.estado, 200);
    const errForbidden = (resForbidden.cuerpo.errors as any[])[0];
    assert.equal(errForbidden.extensions?.status, 403);
    assert.equal(errForbidden.extensions?.code, 'FORBIDDEN');
    assert.ok(errForbidden.extensions?.detail);
  });

  it('7. errorDeServicio traslada fielmente ProblemDetails en extensions', () => {
    const { errorDeServicio } = require('./problemas');
    const problemDetailsOriginal = {
      type: 'https://cozy.example/errors/ALREADY_BOOKED',
      title: 'Habitacion no disponible',
      status: 409,
      detail: 'La habitacion ya se encuentra reservada para esas fechas',
      instance: '/api/v1/orders/create',
      code: 'ALREADY_BOOKED',
    };

    const err = errorDeServicio('reservas', 409, problemDetailsOriginal, 15);
    assert.equal(err.extensions?.code, 'ALREADY_BOOKED');
    assert.equal(err.extensions?.status, 409);
    assert.equal(err.extensions?.detail, 'La habitacion ya se encuentra reservada para esas fechas');
    assert.equal(err.extensions?.instance, '/api/v1/orders/create');
    assert.equal(err.extensions?.retryAfter, 15);
    assert.deepEqual(err.extensions?.problem, problemDetailsOriginal);
  });

  it('8. Propagación de cabeceras de correlación e IP', async () => {
    const servidor = new ServidorGraphql({
      env: { JWT_PUBLIC_KEY: parRsa.publicKey },
      registrar: () => {},
    });

    const cid = 'corr-uuid-test-1234';
    const res = await servidor.ejecutar({
      metodo: 'POST',
      cabeceras: {
        'x-correlation-id': cid,
        'x-forwarded-for': '203.0.113.195',
      },
      cuerpo: JSON.stringify({ query: 'query { alojamientos { id } }' }),
    });

    assert.equal(res.cabeceras['X-Correlation-ID'], cid);
  });
});
