import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { MAX_BYTES_CONSULTA, ServidorGraphql } from './servidor';

// Cuerpo crudo: bodyParser está apagado para poder responder HTTP 200 con errors[] también cuando el JSON llega mal formado
// (el analizador de Nest respondería 400 con su propio formato).
async function leerCuerpo(req: Request): Promise<string | undefined> {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return new Promise((resolver, rechazar) => {
    const trozos: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      // Se deja de acumular mucho antes de que sea un problema; el servidor responde que es demasiado grande
      if (total <= MAX_BYTES_CONSULTA + 1) trozos.push(b);
    });
    req.on('end', () => resolver(total === 0 ? undefined : Buffer.concat(trozos).toString('utf8')));
    req.on('error', rechazar);
  });
}

function cabeceras(req: Request): Record<string, string | undefined> {
  const planas: Record<string, string | undefined> = {};
  for (const [nombre, valor] of Object.entries(req.headers)) {
    planas[nombre.toLowerCase()] = Array.isArray(valor) ? valor.join(', ') : valor;
  }
  return planas;
}

@Controller()
export class GraphqlController {
  constructor(private readonly servidor: ServidorGraphql) {}

  @Get('health')
  salud(@Res() res: Response): void {
    res.status(200).json({ status: 'ok', modulo: 'graphql', uptime: process.uptime() });
  }

  // POST /graphql. Un GET también llega aquí para responder en el mismo formato de error (con 200 y errors[]).
  @Get('graphql')
  async consulta(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.atender(req, res);
  }

  @Post('graphql')
  async operacion(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.atender(req, res);
  }

  private async atender(req: Request, res: Response): Promise<void> {
    let cuerpo: string | undefined;
    try {
      cuerpo = req.method === 'POST' ? await leerCuerpo(req) : undefined;
    } catch {
      cuerpo = undefined;
    }
    const salida = await this.servidor.ejecutar({
      metodo: req.method,
      cuerpo,
      cabeceras: cabeceras(req),
      direccionRemota: req.socket.remoteAddress,
    });
    for (const [nombre, valor] of Object.entries(salida.cabeceras)) res.setHeader(nombre, valor);
    res.status(salida.estado).type('application/json').send(JSON.stringify(salida.cuerpo));
  }
}
