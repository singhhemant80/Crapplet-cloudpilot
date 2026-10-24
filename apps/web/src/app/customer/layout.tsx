import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell';

export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell area="My servers" nav={[{ href: '/customer', label: 'Servers' }]}>
      {children}
    </AppShell>
  );
}
