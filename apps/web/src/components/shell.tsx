'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useApi } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } } }));
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

export interface NavItem {
  href: string;
  label: string;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('cp-theme');
    } catch {}
    const t = (saved as 'light' | 'dark' | null) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(t);
    document.documentElement.dataset.theme = t;
  }, []);
  const flip = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('cp-theme', t);
    } catch {}
  };
  return (
    <button onClick={flip} className="text-sm text-muted hover:text-ink">
      {theme === 'dark' ? 'Light theme' : 'Dark theme'}
    </button>
  );
}

async function logout() {
  await fetch('/api/session', { method: 'DELETE', headers: { 'x-cp-csrf': '1' } });
  window.location.href = '/login';
}

export function AppShell({ area, nav, children }: { area: string; nav: NavItem[]; children: ReactNode }) {
  const path = usePathname();
  const me = useApi<{ tenant: { brandName: string } }>('v1/auth/me');
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => path === href || (href.split('/').length > 2 && path.startsWith(`${href}/`));
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-lg font-bold tracking-tight">{me.data?.tenant.brandName ?? 'CloudPilot'}</div>
            <div className="text-xs text-muted">{area}</div>
          </div>
          <button className="text-sm md:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="cp-nav">
            Menu
          </button>
        </div>
        <nav id="cp-nav" className={clsx('px-3 pb-4 md:block', open ? 'block' : 'hidden')}>
          <ul className="flex flex-col gap-0.5">
            {nav.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  onClick={() => setOpen(false)}
                  aria-current={isActive(n.href) ? 'page' : undefined}
                  className={clsx(
                    'block rounded-md px-3 py-1.5 text-sm',
                    isActive(n.href) ? 'bg-idle-bg font-medium text-ink' : 'text-muted hover:bg-idle-bg hover:text-ink',
                  )}
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-col items-start gap-2 border-t border-line px-3 pt-4">
            <ThemeToggle />
            <button onClick={logout} className="text-sm text-muted hover:text-ink">
              Sign out
            </button>
          </div>
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
