import './registro-rutas';
import { NestFactory } from '@nestjs/core';
import { GraphqlAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // bodyParser apagado: el controlador lee el cuerpo crudo para responder siempre HTTP 200 con errors[]
  const app = await NestFactory.create(GraphqlAppModule, { bodyParser: false });
  const expressApp = app.getHttpAdapter().getInstance();
  if (typeof expressApp?.disable === 'function') expressApp.disable('x-powered-by');
  await app.listen(Number(process.env.PORT_GRAPHQL || process.env.PORT || 3006));
}

if (require.main === module) {
  void bootstrap();
}

