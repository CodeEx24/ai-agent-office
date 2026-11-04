"use client";

import { useActionState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@ago/ui";

import {
  sendCodeAction,
  signInWithOAuthAction,
  verifyCodeAction,
  type SignInState,
} from "./actions";

const INITIAL_STATE: SignInState = { step: "email" };

const OAUTH_BUTTONS = [
  { provider: "google", label: "Continue with Google" },
  { provider: "github", label: "Continue with GitHub" },
] as const;

interface SignInFormProps {
  /** Already validated by safeNextPath on the server. */
  next: string;
  /** Message for a failed callback or provider start, shown above the form. */
  notice?: string;
}

function EmailStep({ next }: { next: string }) {
  const [state, action, isPending] = useActionState(sendCodeAction, INITIAL_STATE);

  if (state.step === "code") return <CodeStep email={state.email} next={next} />;

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="next" value={next} />
      <Label htmlFor="email">Email</Label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        required
        aria-invalid={Boolean(state.error)}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Sending…" : "Email me a sign-in code"}
      </Button>
    </form>
  );
}

function CodeStep({ email, next }: { email: string; next: string }) {
  const [state, action, isPending] = useActionState(verifyCodeAction, {
    step: "code",
    email,
  } as SignInState);

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="email" value={email} />
      <p className="text-sm text-muted-foreground">
        We sent a 6-digit code to <strong>{email}</strong>. Enter it below, or open the link in the
        email.
      </p>
      <Label htmlFor="token">Code</Label>
      <Input
        id="token"
        name="token"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        aria-invalid={Boolean(state.error)}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Verifying…" : "Sign in"}
      </Button>
    </form>
  );
}

export function SignInForm({ next, notice }: SignInFormProps) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Sign in to Agent Office</CardTitle>
        <CardDescription>Use your email, Google or GitHub.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {notice ? (
          <p role="alert" className="text-sm text-destructive">
            {notice}
          </p>
        ) : null}
        <div className="grid gap-2">
          {OAUTH_BUTTONS.map(({ provider, label }) => (
            <form key={provider} action={signInWithOAuthAction}>
              <input type="hidden" name="provider" value={provider} />
              <input type="hidden" name="next" value={next} />
              <Button type="submit" variant="outline" className="w-full">
                {label}
              </Button>
            </form>
          ))}
        </div>
        <div className="text-center text-xs text-muted-foreground uppercase">or</div>
        <EmailStep next={next} />
      </CardContent>
    </Card>
  );
}
