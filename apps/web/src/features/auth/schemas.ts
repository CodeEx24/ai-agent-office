import { z } from "zod";

export const OAUTH_PROVIDERS = ["google", "github"] as const;

export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

export const emailSchema = z.email("Enter a valid email address.").max(254);

/** Length matches `[auth.email] otp_length` in supabase/config.toml. */
export const otpCodeSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code from the email.");

/** Query of `GET /auth/callback`: the one-time code and the post-sign-in path (checked again by safeNextPath). */
export const authCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  next: z.string().max(2048).optional(),
});

const firstOfMany = (value: string | string[]): string =>
  Array.isArray(value) ? (value[0] ?? "") : value;
const queryValue = (maxLength: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform(firstOfMany)
    .pipe(z.string().max(maxLength))
    .optional();

/** Query of `GET /sign-in`. Repeated parameters collapse to the first value; safeNextPath validates `next`. */
export const signInQuerySchema = z.object({
  next: queryValue(2048),
  error: queryValue(64),
});

export const sendCodeSchema = z.object({ email: emailSchema });
export const verifyCodeSchema = z.object({ email: emailSchema, token: otpCodeSchema });
