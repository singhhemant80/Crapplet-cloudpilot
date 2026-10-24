import type { DbOrTx } from '../db/client';
import { auditEvents } from '../db/schema';

export interface AuditActor {
  type: 'user' | 'api_key' | 'system';
  id?: string | null;
  ip?: string | null;
}

export async function audit(
  tx: DbOrTx,
  p: {
    tenantId: string;
    actor: AuditActor;
    action: string;
    resellerId?: string | null;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.insert(auditEvents).values({
    tenantId: p.tenantId,
    actorType: p.actor.type,
    actorId: p.actor.id ?? null,
    ip: p.actor.ip ?? null,
    resellerId: p.resellerId ?? null,
    action: p.action,
    targetType: p.targetType,
    targetId: p.targetId,
    metadata: p.metadata ?? {},
  });
}
