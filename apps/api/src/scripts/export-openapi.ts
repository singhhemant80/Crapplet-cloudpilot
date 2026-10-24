import 'reflect-metadata';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../config/env';
import { createContainer } from '../container';
import { createApp } from '../main';
import { InlineQueue } from '../modules/jobs/inline-queue';

/** Writes docs/openapi.json from the live controller definitions. */
async function main() {
  const env = loadEnv();
  const c = createContainer(env, { queueFactory: (p) => new InlineQueue(p) });
  const app = await createApp(c, env);
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('CloudPilot API').setVersion('1.0').addBearerAuth().build(),
  );
  const out = resolve(__dirname, '../../../../docs/openapi.json');
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`wrote ${out} (${Object.keys(doc.paths).length} paths)`);
  await app.close();
  await c.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
