import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell';

const NAV = [
  { href: '/reseller', label: 'Dashboard' },
  { href: '/reseller/products', label: 'Products & prices' },
  { href: '/reseller/orders', label: 'Orders' },
  { href: '/reseller/services', label: 'Services' },
  { href: '/reseller/wallet', label: 'Wallet' },
  { href: '/reseller/margins', label: 'Sales & margins' },
  { href: '/reseller/integrations', label: 'WHMCS & API' },
];

export default function ResellerLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell area="Reseller portal" nav={NAV}>
      {children}
    </AppShell>
  );
}
