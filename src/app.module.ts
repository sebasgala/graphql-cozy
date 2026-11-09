import './registro-rutas';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphqlController } from './graphql.controller';
import { ServidorGraphql } from './servidor';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' })],
  controllers: [GraphqlController],
  // El esquema se carga y se comprueba al arrancar: si schema.graphql y los resolutores no coinciden, el proceso no levanta
  providers: [{ provide: ServidorGraphql, useFactory: () => new ServidorGraphql() }],
})
export class GraphqlAppModule {}

