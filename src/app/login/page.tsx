import { Suspense } from "react";
import { LoginForm } from "@/components/forge/login-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-forge-bg px-4 text-forge-text">
      <section className="w-full max-w-md rounded-lg border border-forge-line bg-forge-panel p-6 shadow-command">
        <div className="text-sm text-forge-muted">ForgeOS</div>
        <h1 className="mt-2 text-3xl font-semibold text-white">Operator Login</h1>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
