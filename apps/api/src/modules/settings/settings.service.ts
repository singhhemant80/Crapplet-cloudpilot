import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, DbOrTx } from '../../db/client';
import { tenants } from '../../db/schema';
import { NotFound } from '../../common/errors';

/** GSTIN: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum. */
export const GSTIN_RE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const tenantSettingsSchema = z.object({
  company: z
    .object({
      legalName: z.string().max(200).default(''),
      address: z.string().max(500).default(''),
      gstin: z.string().regex(GSTIN_RE, 'Invalid GSTIN').or(z.literal('')).default(''),
      /** Two-digit GST state code of the registered place of business. */
      stateCode: z.string().regex(/^\d{2}$/).or(z.literal('')).default(''),
      supportEmail: z.string().email().or(z.literal('')).default(''),
      phone: z.string().max(40).default(''),
      panelUrl: z.string().max(200).default(''),
    })
    .default({}),
  billing: z
    .object({
      /** Up to 3 characters; full number "CP/2026-27/00001" stays within GST's 16-character limit. */
      invoicePrefix: z.string().regex(/^[A-Z0-9]{1,3}$/).default('CP'),
      currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
      /** Days between issue and due date for new invoices. */
      dueDays: z.number().int().min(0).max(60).default(7),
      /** Renewal invoices are generated this many days before the due date. */
      renewalLeadDays: z.number().int().min(0).max(60).default(7),
      /** Days after the due date before an unpaid service is suspended. */
      graceDays: z.number().int().min(0).max(60).default(3),
      autoSuspend: z.boolean().default(true),
      /** 0 = never terminate automatically. */
      autoTerminateDays: z.number().int().min(0).max(365).default(0),
      /** Unpaid new-order invoices are cancelled (and the IP released) after this many hours. */
      orderPaymentWindowHours: z.number().int().min(1).max(720).default(48),
      bankDetails: z.string().max(1000).default(''),
    })
    .default({}),
  store: z
    .object({
      allowSignup: z.boolean().default(true),
    })
    .default({}),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

export class SettingsService {
  constructor(private readonly db: Database) {}

  async get(tx: DbOrTx, tenantId: string): Promise<TenantSettings & { brandName: string; name: string }> {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!t) throw NotFound('Tenant');
    return { ...tenantSettingsSchema.parse(t.settings ?? {}), brandName: t.brandName, name: t.name };
  }

  /** Deep-merges a partial update, validates the whole document, saves it. */
  async update(tenantId: string, patch: { company?: Partial<TenantSettings['company']>; billing?: Partial<TenantSettings['billing']>; store?: Partial<TenantSettings['store']>; brandName?: string }) {
    const cur = await this.get(this.db, tenantId);
    const next = tenantSettingsSchema.parse({
      company: { ...cur.company, ...patch.company },
      billing: { ...cur.billing, ...patch.billing },
      store: { ...cur.store, ...patch.store },
    });
    await this.db
      .update(tenants)
      .set({ settings: next, ...(patch.brandName ? { brandName: patch.brandName } : {}) })
      .where(eq(tenants.id, tenantId));
    return this.get(this.db, tenantId);
  }
}
