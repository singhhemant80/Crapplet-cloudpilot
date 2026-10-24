import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { loadEnv, type Env } from './config/env';
import { createContainer, type Container } from './container';
import { AppModule } from './app.module';
import { BullMqQueue } from './modules/jobs/bullmq-queue';
import { log } from './http/common';

// Money is BigInt minor units internally; it is serialized as a decimal string.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

export async function createApp(container: Container, env: Env) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forContainer(container), {
    rawBody: true, // payment webhooks verify signatures over the exact bytes received
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', 'loopback'); // behind the bundled nginx reverse proxy
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.useBodyParser('urlencoded', { extended: false, limit: '64kb' });
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({ origin: env.WEB_ORIGIN.split(','), credentials: true });

  const doc = new DocumentBuilder()
    .setTitle('CloudPilot API')
    .setDescription('Admin, reseller (universal billing integration) and customer APIs. Money fields ending in "Minor" are integer minor units as strings.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
  return app;
}

async function bootstrap() {
  const env = loadEnv();
  const container = createContainer(env, { queueFactory: (c) => new BullMqQueue(c.redis, env.PROVISIONING_MAX_ATTEMPTS) });
  const app = await createApp(container, env);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  log.info({ port: env.API_PORT }, 'CloudPilot API listening');
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
