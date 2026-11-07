import { Link } from '../lib/router';

export function NotFoundPage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold">Página não encontrada</h1>
      <p className="text-sm text-muted">O endereço não existe ou foi movido.</p>
      <Link href="/" className="font-medium text-brand hover:underline">
        Ir para o início
      </Link>
    </main>
  );
}
