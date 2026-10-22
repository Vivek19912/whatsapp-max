"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertTriangle, CheckCircle, Eye, EyeOff } from "lucide-react";
import {
  NEW_PASSWORD_MIN_LENGTH,
  RECOVERY_ERROR_COPY,
  isRecoveryErrorSlug,
  recoveryUpdateErrorMessage,
  validateNewPassword,
} from "@/lib/auth/recovery";

// Set a new password after following a recovery link.
// Reached via /auth/callback?next=/reset-password once Supabase has
// verified the OTP and the exchange established a recovery session.
// Expired/used links never get here with a session — they land with
// ?error=<slug> and see guidance plus a way to request a new email.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordPageInner />
    </Suspense>
  );
}

function ResetPasswordPageInner() {
  const searchParams = useSearchParams();
  const errorSlug = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  if (errorSlug !== null) {
    const copy = isRecoveryErrorSlug(errorSlug)
      ? RECOVERY_ERROR_COPY[errorSlug]
      : RECOVERY_ERROR_COPY.invalid;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle className="text-xl text-foreground">Reset link invalid</CardTitle>
            <CardDescription className="text-muted-foreground">{copy}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/forgot-password">
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Send a new reset link
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validationError = validateNewPassword(password, confirmPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    // Authenticated password update on the recovery session —
    // service-role keys are never involved client-side.
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });
    if (updateError) {
      setError(recoveryUpdateErrorMessage(updateError));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Password updated
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Your password has been changed. Sign in with your new password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center">
            <Image
              src="/logo.png"
              alt="WhatsApp Max"
              width={48}
              height={48}
              className="rounded-xl"
            />
          </div>
          <CardTitle className="text-xl text-foreground">
            Choose a new password
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Enter and confirm your new password below
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                New password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={`At least ${NEW_PASSWORD_MIN_LENGTH} characters`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="border-border bg-muted pr-10 text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password" className="text-muted-foreground">
                Confirm new password
              </Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="Repeat your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="border-border bg-muted pr-10 text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                />
                <button
                  type="button"
                  aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowConfirmPassword((v) => !v)}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save new password"}
            </Button>
          </form>

          <Link
            href="/login"
            className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
