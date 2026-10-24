'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button, Field, Input } from '@/components/ui';
import { HOME_FOR_ROLE } from '@/lib/roles';

const schema = z.object({
  email: z.string().email('Enter the email you sign in with'),
  password: z.string().min(1, 'Enter your password'),
});

function LoginForm() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cp-csrf': '1' }, body: JSON.stringify(v) });
    const data = await res.json();
    if (!res.ok) return setError(data?.error?.message ?? 'Sign-in failed');
    const next = params.get('next');
    window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : (HOME_FOR_ROLE[data.user.role] ?? '/');
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <Field label="Email" error={formState.errors.email?.message}>
        <Input type="email" autoComplete="username" autoFocus {...register('email')} />
      </Field>
      <Field label="Password" error={formState.errors.password?.message}>
        <Input type="password" autoComplete="current-password" {...register('password')} />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <Button type="submit" busy={formState.isSubmitting}>
        Sign in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen md:grid-cols-[1fr_480px]">
      <div className="hidden flex-col justify-between bg-ink p-10 text-paper md:flex">
        <div className="text-xl font-bold tracking-tight">CloudPilot</div>
        <div className="max-w-md">
          <p className="text-3xl font-semibold leading-tight">Every VPS, every rupee and every IP — accounted for.</p>
          <p className="mt-4 text-paper/70">
            Provisioning, reseller wallets and IP inventory for Crapplet Cloud, in one place.
          </p>
        </div>
        <div className="text-sm text-paper/50">Crapplet Infotech Private Limited</div>
      </div>
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h1 className="mb-1 text-2xl font-semibold">Sign in</h1>
          <p className="mb-6 text-sm text-muted">Administrators, resellers and customers use the same sign-in.</p>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
