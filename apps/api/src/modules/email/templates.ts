/**
 * Built-in email templates. Admins can override subject and body per tenant
 * (email_templates table). Placeholders: {{name}}; unknown ones render empty.
 * Every template also receives {{brand}}, {{panelUrl}} and {{supportEmail}}.
 */
export interface TemplateDef {
  subject: string;
  body: string;
  description: string;
  variables: string[];
}

export const DEFAULT_TEMPLATES: Record<string, TemplateDef> = {
  'account.welcome': {
    description: 'Sent to a customer after they sign up',
    variables: ['name', 'email'],
    subject: 'Welcome to {{brand}}',
    body: `Hello {{name}},

Your {{brand}} account is ready. Sign in at {{panelUrl}} with {{email}} to order servers, pay invoices and open support tickets.

{{brand}}`,
  },
  'auth.password_reset': {
    description: 'Password reset link',
    variables: ['name', 'resetUrl'],
    subject: 'Reset your {{brand}} password',
    body: `Hello {{name}},

Use this link within 60 minutes to choose a new password:
{{resetUrl}}

If you did not ask for this, ignore this email; your password stays the same.

{{brand}}`,
  },
  'invoice.created': {
    description: 'A new invoice was issued to a customer',
    variables: ['name', 'invoiceNumber', 'total', 'dueDate', 'invoiceUrl'],
    subject: 'Invoice {{invoiceNumber}} — {{total}} due {{dueDate}}',
    body: `Hello {{name}},

Invoice {{invoiceNumber}} for {{total}} is due on {{dueDate}}.
View and pay it here: {{invoiceUrl}}

{{brand}}`,
  },
  'invoice.paid': {
    description: 'Payment received',
    variables: ['name', 'invoiceNumber', 'amount'],
    subject: 'Payment received for invoice {{invoiceNumber}}',
    body: `Hello {{name}},

We received {{amount}} for invoice {{invoiceNumber}}. Thank you.

{{brand}}`,
  },
  'invoice.overdue': {
    description: 'Invoice is past its due date',
    variables: ['name', 'invoiceNumber', 'total', 'dueDate', 'invoiceUrl', 'suspendDate'],
    subject: 'Overdue: invoice {{invoiceNumber}}',
    body: `Hello {{name}},

Invoice {{invoiceNumber}} for {{total}} was due on {{dueDate}} and is still unpaid.
Services on this invoice will be suspended on {{suspendDate}} if it remains unpaid.
Pay now: {{invoiceUrl}}

{{brand}}`,
  },
  'service.active': {
    description: 'A server is ready',
    variables: ['name', 'hostname', 'ips', 'username', 'serviceUrl'],
    subject: 'Your server {{hostname}} is ready',
    body: `Hello {{name}},

Your server {{hostname}} is running.

IP address: {{ips}}
Login user: {{username}}
Password: the one you chose when ordering

Connect with: ssh {{username}}@{{ips}}
Manage it here: {{serviceUrl}}

{{brand}}`,
  },
  'service.suspended': {
    description: 'A server was suspended',
    variables: ['name', 'hostname', 'reason'],
    subject: 'Server {{hostname}} suspended',
    body: `Hello {{name}},

Your server {{hostname}} has been suspended: {{reason}}.
Paying the outstanding invoice restores it automatically.

{{brand}}`,
  },
  'service.unsuspended': {
    description: 'A server was restored',
    variables: ['name', 'hostname'],
    subject: 'Server {{hostname}} restored',
    body: `Hello {{name}},

Your server {{hostname}} is running again.

{{brand}}`,
  },
  'ticket.reply': {
    description: 'Staff replied to a customer or reseller ticket',
    variables: ['name', 'ticketNumber', 'subject', 'message', 'ticketUrl'],
    subject: '[Ticket #{{ticketNumber}}] {{subject}}',
    body: `Hello {{name}},

{{message}}

Reply here: {{ticketUrl}}

{{brand}} support`,
  },
  'staff.ticket': {
    description: 'Staff alert: new ticket or customer reply',
    variables: ['ticketNumber', 'subject', 'from', 'message', 'ticketUrl'],
    subject: '[Ticket #{{ticketNumber}}] {{subject}} — {{from}}',
    body: `{{from}} wrote:

{{message}}

Open: {{ticketUrl}}`,
  },
  'staff.order_failed': {
    description: 'Staff alert: a paid customer order could not be provisioned',
    variables: ['orderNumber', 'customer', 'reason', 'orderUrl'],
    subject: 'Paid order #{{orderNumber}} failed to provision',
    body: `Order #{{orderNumber}} for {{customer}} failed: {{reason}}

The customer has paid. Retry the order or refund the payment at the gateway.
{{orderUrl}}`,
  },
};

export function render(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}
