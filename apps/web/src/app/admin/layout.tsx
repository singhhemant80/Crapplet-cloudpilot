import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/orders', label: 'Orders & provisioning' },
  { href: '/admin/services', label: 'Services' },
  { href: '/admin/resellers', label: 'Resellers' },
  { href: '/admin/deposits', label: 'Deposits' },
  { href: '/admin/products', label: 'Products & pricing' },
  { href: '/admin/hypervisors', label: 'Hypervisors' },
  { href: '/admin/ipam', label: 'IP addresses' },
  { href: '/admin/audit', label: 'Audit log' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell area="Administration" nav={NAV}>
      {children}
    </AppShell>
  );
}
