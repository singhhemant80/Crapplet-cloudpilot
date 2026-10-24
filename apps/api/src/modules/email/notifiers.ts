import { eq } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { customers } from '../../db/schema';
import type { ProvisioningNotifier } from '../provisioning/provisioning.service';
import type { ServiceNotifier } from '../services/service-ops.service';
import type { SettingsService } from '../settings/settings.service';
import type { EmailService } from './email.service';

/** Email notifications for direct (store) customers, queued inside the business transaction. */
export function customerNotifiers(email: EmailService, settings: SettingsService): ProvisioningNotifier & ServiceNotifier {
  const customer = async (tx: Tx, id: string) => (await tx.select().from(customers).where(eq(customers.id, id)))[0];
  return {
    async serviceActive(tx, p) {
      const c = await customer(tx, p.customerId);
      const s = await settings.get(tx, p.tenantId);
      await email.queue(tx, {
        tenantId: p.tenantId,
        to: c?.email,
        key: 'service.active',
        vars: { name: c?.name, hostname: p.hostname, ips: p.ips.join(', '), username: p.username, serviceUrl: `${s.company.panelUrl}/customer/services/${p.serviceId}` },
        related: { type: 'service', id: p.serviceId },
      });
    },
    async orderFailed(tx, p) {
      const c = p.customerId ? await customer(tx, p.customerId) : undefined;
      const s = await settings.get(tx, p.tenantId);
      await email.queueStaff(tx, p.tenantId, 'staff.order_failed', {
        orderNumber: p.orderNumber,
        customer: c ? `${c.name} <${c.email ?? ''}>` : 'unknown customer',
        reason: p.reason,
        orderUrl: `${s.company.panelUrl}/admin/orders/${p.orderId}`,
      }, { type: 'order', id: p.orderId });
    },
    async statusChanged(tx, p) {
      const c = await customer(tx, p.customerId);
      await email.queue(tx, {
        tenantId: p.tenantId,
        to: c?.email,
        key: p.event,
        vars: { name: c?.name, hostname: p.hostname, reason: p.reason ?? '' },
      });
    },
  };
}
