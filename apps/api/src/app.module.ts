import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Container } from './container';
import { AccessGuard, CONTAINER, ErrorFilter } from './http/common';
import { AdminController } from './http/admin.controller';
import { ResellerController } from './http/reseller.controller';
import { AuthController, CustomerController, HealthController, PaymentsController } from './http/misc.controllers';

@Module({})
export class AppModule {
  /** The container is built outside Nest so the worker and tests share the exact same wiring. */
  static forContainer(container: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, AdminController, ResellerController, CustomerController, PaymentsController],
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
