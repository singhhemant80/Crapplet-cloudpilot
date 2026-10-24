import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'CloudPilot',
  description: 'Hosting automation, billing and reseller control plane',
};

// Applies the saved theme before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem('cp-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
