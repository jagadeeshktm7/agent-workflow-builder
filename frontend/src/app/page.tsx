"use client";

import { useState } from "react";
import {
  useSignUpEmailPassword,
  useSignInEmailPassword,
  useUserData,
} from "@nhost/react";
import { nhostConfigured } from "@/lib/nhost";
import { useQuery } from "urql";

export default function AuthScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-8">
        <h1 className="text-2xl font-semibold">AI Workflow Builder</h1>
        <p className="mt-1 text-sm text-zinc-400">
          nhost (Hasura + Auth) / Next.js — Phase 0 connectivity check
        </p>
        {!nhostConfigured ? (
          <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
            NEXT_PUBLIC_NHOST_SUBDOMAIN / NEXT_PUBLIC_NHOST_REGION are not set
            in <code>frontend/.env.local</code>. Add them and restart{" "}
            <code>npm run dev</code>.
          </div>
        ) : (
          <AuthForms />
        )}
      </div>
    </main>
  );
}

function AuthForms() {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { signUpEmailPassword, isLoading: signingUp } =
    useSignUpEmailPassword();
  const { signInEmailPassword, isLoading: signingIn } =
    useSignInEmailPassword();

  const isSignup = mode === "signup";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // nhost default role is "user"; password min length is 9 on this project.
    const { error } = isSignup
      ? await signUpEmailPassword(email, password)
      : await signInEmailPassword(email, password);
    if (error) setError(error.message);
  };

  const user = useUserData();
  if (user) return <SignedIn />;

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 outline-none focus:border-indigo-500"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password (min 9 chars)
        <input
          type="password"
          required
          minLength={9}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 outline-none focus:border-indigo-500"
        />
      </label>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={signingUp || signingIn}
        className="rounded-lg bg-indigo-600 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        {isSignup ? "Sign up" : "Sign in"}
      </button>

      <button
        type="button"
        onClick={() => setMode(isSignup ? "signin" : "signup")}
        className="text-sm text-zinc-400 underline-offset-2 hover:underline"
      >
        {isSignup ? "Already have an account? Sign in" : "New here? Sign up"}
      </button>
    </form>
  );
}

function SignedIn() {
  const user = useUserData();

  return (
    <div className="mt-6">
      <p className="text-sm text-zinc-400">
        Signed in as{" "}
        <span className="font-medium text-zinc-100">{user?.email}</span>
        <span className="ml-2 text-xs text-zinc-500">
          (JWT claims role: <code>user</code>)
        </span>
      </p>
      <GraphQLProbe />
    </div>
  );
}

function GraphQLProbe() {
  // urql's useQuery through our provider: the client attaches the session JWT.
  // A 200 with data proves: nhost Auth -> JWT -> Hasura session vars -> role "user".
  const [{ fetching, data, error }] = useQuery({
    query: `query Probe { __typename }`,
  });

  return (
    <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <p className="text-sm text-zinc-300">
        GraphQL probe via @nhost/nextjs <code>useQuery</code> (JWT attached)
      </p>
      <div className="mt-3 rounded bg-black/50 p-3 text-xs">
        {fetching && <span className="text-zinc-400">fetching…</span>}
        {data && (
          <pre className="text-emerald-300">{JSON.stringify(data, null, 2)}</pre>
        )}
        {error && (
          <pre className="text-red-300">{JSON.stringify(error, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}