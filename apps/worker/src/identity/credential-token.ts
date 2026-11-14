// Moved to `@ago/shared/credential-token` in AGO-58 so the web app verifies tokens with the same code. This file
// keeps the worker's import path stable.
export {
  hashCredentialToken,
  signCredentialToken,
  verifyCredentialToken,
  type TokenCheck,
} from "@ago/shared/credential-token";
