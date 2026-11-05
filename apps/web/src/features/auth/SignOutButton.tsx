import { Button } from "@ago/ui";

import { signOutAction } from "./actions";

/** A POST form (server action), never a link: prefetching a link must not sign the user out. */
export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="outline" size="sm">
        Sign out
      </Button>
    </form>
  );
}
