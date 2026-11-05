import { z } from "zod";

export const OAUTH_PROVIDERS = ["google", "github"] as const;

export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

export const emailSchema = z.email("Enter a valid email address.").max(254);

/** Length matches `[auth.email] otp_length` in supabase/config.toml. */
export const otpCodeSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code from the email.");

export const sendCodeSchema = z.object({ email: emailSchema });
export const verifyCodeSchema = z.object({ email: emailSchema, token: otpCodeSchema });
