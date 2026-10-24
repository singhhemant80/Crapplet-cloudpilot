import PDFDocument from 'pdfkit';
import type { invoiceLines, invoices, payments } from '../../db/schema';
import type { TenantSettings } from '../settings/settings.service';

type Inv = typeof invoices.$inferSelect & { lines: Array<typeof invoiceLines.$inferSelect>; payments: Array<typeof payments.$inferSelect> };

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function threeDigits(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}

/** Indian numbering in words (lakh/crore), e.g. 118000 → "One Lakh Eighteen Thousand". */
export function inWordsIndian(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const rest = n % 1e3;
  if (crore) parts.push(`${inWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

export function amountInWords(minor: bigint, currency: string): string {
  const rupees = Number(minor / 100n);
  const paise = Number(minor % 100n);
  if (currency !== 'INR') return `${currency} ${inWordsIndian(rupees)}${paise ? ` and ${paise}/100` : ''} only`;
  return `Rupees ${inWordsIndian(rupees)}${paise ? ` and ${twoDigits(paise)} Paise` : ''} only`;
}

const m = (v: bigint) => (Number(v) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : '—');

/** A4 tax invoice with the particulars required by CGST Rule 46. Built-in Helvetica (no ₹ glyph), so amounts show the currency code. */
export function renderInvoicePdf(inv: Inv, s: TenantSettings & { brandName: string; name: string }, states: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${inv.number}`, Author: s.company.legalName || s.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 48;
    const width = doc.page.width - 96;
    const taxInvoice = inv.taxType === 'INTRA' || inv.taxType === 'INTER';

    doc.font('Helvetica-Bold').fontSize(16).text(s.company.legalName || s.name, left, 48);
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(s.company.address || '', { width: 300 });
    if (s.company.gstin) doc.text(`GSTIN: ${s.company.gstin}   State: ${states[s.company.stateCode] ?? ''} (${s.company.stateCode})`);
    if (s.company.supportEmail) doc.text(s.company.supportEmail);

    doc.fillColor('#000').font('Helvetica-Bold').fontSize(14).text(taxInvoice ? 'TAX INVOICE' : inv.taxType === 'EXPORT' ? 'INVOICE (EXPORT OF SERVICES)' : 'INVOICE', left, 48, { width, align: 'right' });
    doc.font('Helvetica').fontSize(9);
    const meta: Array<[string, string]> = [
      ['Invoice no.', inv.number ?? 'DRAFT'],
      ['Date', d(inv.issueDate)],
      ['Due date', d(inv.dueDate)],
      ['Status', inv.status],
    ];
    if (inv.placeOfSupply) meta.push(['Place of supply', inv.placeOfSupply === '96' ? 'Outside India (96)' : `${states[inv.placeOfSupply] ?? ''} (${inv.placeOfSupply})`]);
    meta.forEach(([k, v]) => doc.text(`${k}: ${v}`, left, undefined, { width, align: 'right' }));

    let y = 170;
    doc.font('Helvetica-Bold').text('Bill to', left, y);
    doc.font('Helvetica').text(inv.buyerName, left, y + 12, { width: 280 });
    if (inv.buyerAddress) doc.text(inv.buyerAddress, { width: 280 });
    if (inv.buyerGstin) doc.text(`GSTIN: ${inv.buyerGstin}`);
    if (inv.periodStart && inv.periodEnd) doc.text(`Service period: ${d(inv.periodStart)} to ${d(inv.periodEnd)}`);

    y = Math.max(doc.y + 20, 270);
    const cols = [
      { h: 'Description', x: left, w: 230, a: 'left' as const },
      { h: 'HSN/SAC', x: left + 235, w: 55, a: 'left' as const },
      { h: 'Qty', x: left + 290, w: 30, a: 'right' as const },
      { h: 'Rate', x: left + 320, w: 70, a: 'right' as const },
      { h: 'GST %', x: left + 390, w: 40, a: 'right' as const },
      { h: `Amount (${inv.currency})`, x: left + 430, w: width - 430, a: 'right' as const },
    ];
    doc.rect(left, y - 4, width, 18).fill('#f0f2f5').fillColor('#000').font('Helvetica-Bold');
    cols.forEach((c) => doc.text(c.h, c.x, y, { width: c.w, align: c.a }));
    doc.font('Helvetica');
    y += 20;
    for (const l of inv.lines) {
      const vals = [l.description, l.hsnSac ?? '', String(l.quantity), m(l.unitMinor), taxInvoice ? String(l.taxRateBp / 100) : '—', m(l.amountMinor)];
      const h = doc.heightOfString(l.description, { width: cols[0].w });
      cols.forEach((c, i) => doc.text(vals[i], c.x, y, { width: c.w, align: c.a }));
      y += Math.max(h, 12) + 6;
      doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#e3e6ea').stroke();
    }

    const totals: Array<[string, bigint, boolean?]> = [['Taxable value', inv.subtotalMinor]];
    if (inv.taxType === 'INTRA') {
      const half = inv.lines[0] ? inv.lines[0].taxRateBp / 200 : 0;
      totals.push([`CGST${half ? ` @ ${half}%` : ''}`, inv.cgstMinor], [`SGST${half ? ` @ ${half}%` : ''}`, inv.sgstMinor]);
    } else if (inv.taxType === 'INTER') {
      totals.push([`IGST${inv.lines[0] ? ` @ ${inv.lines[0].taxRateBp / 100}%` : ''}`, inv.igstMinor]);
    }
    totals.push(['Total', inv.totalMinor, true]);
    if (inv.paidMinor > 0n) totals.push(['Paid', inv.paidMinor], ['Balance due', inv.totalMinor - inv.paidMinor, true]);
    y += 6;
    for (const [k, v, bold] of totals) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(k, left + 280, y, { width: 150, align: 'right' }).text(m(v), left + 430, y, { width: width - 430, align: 'right' });
      y += 14;
    }
    doc.font('Helvetica').fontSize(9).text(`Amount in words: ${amountInWords(inv.totalMinor, inv.currency)}`, left, y + 8, { width });
    if (inv.taxType === 'EXPORT') doc.text('Export of services under LUT without payment of IGST.', { width });
    if (inv.taxType === 'NONE' && !s.company.gstin) doc.text('Supplier not registered under GST; no tax charged.', { width });
    if (s.billing.bankDetails && inv.status !== 'PAID') doc.moveDown().font('Helvetica-Bold').text('Bank details').font('Helvetica').text(s.billing.bankDetails, { width });
    if (inv.payments.some((p) => p.status === 'SUCCEEDED')) {
      doc.moveDown().font('Helvetica-Bold').text('Payments');
      doc.font('Helvetica');
      inv.payments.filter((p) => p.status === 'SUCCEEDED').forEach((p) => doc.text(`${d(p.paidAt)}  ${p.gateway}  ${p.gatewayPaymentId ?? ''}  ${inv.currency} ${m(p.amountMinor)}`));
    }
    doc.fontSize(8).fillColor('#777').text('This is a computer-generated invoice and does not require a signature.', left, doc.page.height - 70, { width, align: 'center' });
    doc.end();
  });
}
