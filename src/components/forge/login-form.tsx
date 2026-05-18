"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      const payload = (await response.json()) as { success: boolean; error?: string };
      if (!payload.success) {
        setError(payload.error ?? "Login failed.");
        return;
      }

      const next = searchParams.get("next");
      router.replace(next?.startsWith("/") ? next : "/forges");
      router.refresh();
    } catch {
      setError("Login failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={login} className="mt-6 space-y-4">
      <label className="block">
        <span className="mb-2 block text-xs uppercase text-forge-muted">Operator Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
          autoComplete="current-password"
          autoFocus
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded bg-forge-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-60"
      >
        <Lock className="h-4 w-4" />
        Enter ForgeOS
      </button>
      {error ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
    </form>
  );
}
