import { hmacSha256Hex, safeEqualHex } from '../../common/crypto';

export interface CheckoutRequest {
  depositId: string;
  amountMinor: bigint;
  currency: string;
  description: string;
}

export interface CheckoutSession {
  gatewayOrderId: string;
  /** URL the reseller is sent to (sandbox) or data for a client-side checkout widget (Razorpay). */
  checkoutUrl?: string;
  clientPayload?: Record<string, unknown>;
}

export interface VerifiedPaymentEvent {
  eventId: string;
  gatewayOrderId: string;
  gatewayPaymentId: string;
  amountMinor: bigint;
  currency: string;
  outcome: 'captured' | 'failed' | 'ignored';
}

export interface PaymentGateway {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Verifies the webhook signature over the RAW body. Returns null if the signature is invalid. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<VerifiedPaymentEvent | null>;
}

/**
 * Built-in sandbox gateway for development and staging. Its webhook is signed
 * with SANDBOX_GATEWAY_SECRET exactly like a real gateway, so the same verified
 * code path credits wallets. It refuses to load in production (see env.ts).
 */
export class SandboxGateway implements PaymentGateway {
  readonly name = 'sandbox';
  constructor(
    private readonly secret: string,
    private readonly publicApiUrl: string,
  ) {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const gatewayOrderId = `sbx_order_${req.depositId.replace(/-/g, '').slice(0, 20)}`;
    return { gatewayOrderId, checkoutUrl: `${this.publicApiUrl}/v1/payments/sandbox/checkout/${gatewayOrderId}` };
  }

  sign(rawBody: string) {
    return hmacSha256Hex(this.secret, rawBody);
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<VerifiedPaymentEvent | null> {
    const sig = headers['x-sandbox-signature'];
    if (!sig || !safeEqualHex(sig, this.sign(rawBody))) return null;
    const body = JSON.parse(rawBody) as {
      id: string;
      type: 'payment.captured' | 'payment.failed';
      data: { orderId: string; paymentId: string; amountMinor: string; currency: string };
    };
    return {
      eventId: body.id,
      gatewayOrderId: body.data.orderId,
      gatewayPaymentId: body.data.paymentId,
      amountMinor: BigInt(body.data.amountMinor),
      currency: body.data.currency,
      outcome: body.type === 'payment.captured' ? 'captured' : 'failed',
    };
  }
}

/**
 * Razorpay (Orders API + webhooks). The webhook signature is HMAC-SHA256 of the raw
 * body with the webhook secret (X-Razorpay-Signature). After a valid webhook we
 * additionally fetch the payment server-side and require status=captured with a
 * matching order id and amount before crediting.
 * Requires live validation with real test-mode keys (see docs/integrations/payments.md).
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private auth() {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const res = await this.fetchImpl('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(req.amountMinor), currency: req.currency, receipt: req.depositId.slice(0, 40), notes: { depositId: req.depositId } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Razorpay order creation failed: HTTP ${res.status}`);
    const order = (await res.json()) as { id: string };
    return { gatewayOrderId: order.id, clientPayload: { key: this.keyId, order_id: order.id, amount: Number(req.amountMinor), currency: req.currency, description: req.description } };
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<VerifiedPaymentEvent | null> {
    const sig = headers['x-razorpay-signature'];
    if (!sig || !safeEqualHex(sig, hmacSha256Hex(this.webhookSecret, rawBody))) return null;
    const body = JSON.parse(rawBody) as { event: string; payload?: { payment?: { entity?: { id: string; order_id: string; amount: number; currency: string; status: string } } } };
    const p = body.payload?.payment?.entity;
    const eventId = headers['x-razorpay-event-id'] ?? `${body.event}:${p?.id ?? 'none'}`;
    if (!p || !['payment.captured', 'order.paid', 'payment.failed'].includes(body.event)) {
      return { eventId, gatewayOrderId: p?.order_id ?? '', gatewayPaymentId: p?.id ?? '', amountMinor: 0n, currency: p?.currency ?? '', outcome: 'ignored' };
    }
    if (body.event === 'payment.failed') {
      return { eventId, gatewayOrderId: p.order_id, gatewayPaymentId: p.id, amountMinor: BigInt(p.amount), currency: p.currency, outcome: 'failed' };
    }
    // Server-side confirmation — never trust the webhook body alone for money movement.
    const res = await this.fetchImpl(`https://api.razorpay.com/v1/payments/${encodeURIComponent(p.id)}`, {
      headers: { Authorization: this.auth() },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Razorpay payment lookup failed: HTTP ${res.status}`);
    const live = (await res.json()) as { id: string; order_id: string; amount: number; currency: string; status: string };
    if (live.status !== 'captured' || live.order_id !== p.order_id) {
      return { eventId, gatewayOrderId: p.order_id, gatewayPaymentId: p.id, amountMinor: BigInt(live.amount), currency: live.currency, outcome: 'ignored' };
    }
    return { eventId, gatewayOrderId: live.order_id, gatewayPaymentId: live.id, amountMinor: BigInt(live.amount), currency: live.currency, outcome: 'captured' };
  }
}
