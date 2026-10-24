/**
 * Indian GST rules used on invoices. Pure functions, unit-tested.
 *
 *  - Seller not GST-registered (no GSTIN)      → NONE  (no tax charged)
 *  - Buyer outside India                       → EXPORT (zero-rated export of services, no tax)
 *  - Place of supply = seller's state          → INTRA (CGST + SGST, half the rate each)
 *  - Place of supply = another Indian state    → INTER (IGST, full rate)
 *
 * Place of supply for these B2B/B2C services is the buyer's state when known
 * (IGST Act s.12(2)); without a buyer state it falls back to the supplier's state.
 * Rates come from each product (gstRateBp), never a single hard-coded rate.
 */

export type TaxType = 'INTRA' | 'INTER' | 'EXPORT' | 'NONE';

export interface TaxContext {
  sellerGstin: string;
  sellerStateCode: string;
  buyerCountry: string;
  buyerStateCode?: string | null;
}

export interface LineInput {
  amountMinor: bigint; // taxable value of the line
  taxRateBp: number; // 1800 = 18%
}

export interface TaxResult {
  taxType: TaxType;
  placeOfSupply: string | null;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  taxMinor: bigint;
  subtotalMinor: bigint;
  totalMinor: bigint;
}

/** amount × bp / (10000 × div), rounded half up to the nearest paisa, in exact integer arithmetic. */
export function pct(amount: bigint, bp: number, div = 1n): bigint {
  const den = 10000n * div;
  return (amount * BigInt(bp) * 2n + den) / (2n * den);
}

export function taxTypeFor(ctx: TaxContext): { taxType: TaxType; placeOfSupply: string | null } {
  if (!ctx.sellerGstin) return { taxType: 'NONE', placeOfSupply: null };
  if (ctx.buyerCountry && ctx.buyerCountry.toUpperCase() !== 'IN') return { taxType: 'EXPORT', placeOfSupply: '96' }; // 96 = foreign country
  const pos = ctx.buyerStateCode || ctx.sellerStateCode;
  return { taxType: pos === ctx.sellerStateCode ? 'INTRA' : 'INTER', placeOfSupply: pos };
}

export function computeTax(ctx: TaxContext, lines: LineInput[]): TaxResult {
  const { taxType, placeOfSupply } = taxTypeFor(ctx);
  let subtotal = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  for (const l of lines) {
    subtotal += l.amountMinor;
    if (taxType === 'INTRA') {
      cgst += pct(l.amountMinor, l.taxRateBp, 2n);
      sgst += pct(l.amountMinor, l.taxRateBp, 2n);
    } else if (taxType === 'INTER') {
      igst += pct(l.amountMinor, l.taxRateBp);
    }
  }
  const tax = cgst + sgst + igst;
  return { taxType, placeOfSupply, cgstMinor: cgst, sgstMinor: sgst, igstMinor: igst, taxMinor: tax, subtotalMinor: subtotal, totalMinor: subtotal + tax };
}

/** Indian financial year label for a date: April–March, e.g. 2026-10-24 → "2026-27". */
export function financialYear(d: Date): string {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** "CP/2026-27/00042" — at most 16 characters as GST requires. */
export function invoiceNumber(prefix: string, fy: string, seq: number): string {
  const n = `${prefix}/${fy}/${String(seq).padStart(5, '0')}`;
  if (n.length > 16) throw new Error(`Invoice number ${n} exceeds 16 characters; shorten the prefix`);
  return n;
}

export function validGstinStateMatches(gstin: string, stateCode: string): boolean {
  return !gstin || gstin.slice(0, 2) === stateCode;
}
