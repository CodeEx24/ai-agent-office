import type { ConfigProposal } from "@ago/shared";

/**
 * Where agent change proposals are kept until a person reviews them (AGO-154). The Postgres implementation
 * (a `config_proposals` table with RLS) is a follow-up ticket that needs the schema slot; until then the
 * in-memory store below is the only implementation. The store only ever creates pending proposals: there is
 * no method here that applies, approves or edits one, so the agent path cannot do any of those.
 */
export interface ProposalStore {
  create(proposal: ConfigProposal): Promise<void>;
}

/** For tests and local runs. Proposals are lost when the process ends. */
export interface InMemoryProposalStore extends ProposalStore {
  list(): readonly ConfigProposal[];
}

export function createInMemoryProposalStore(): InMemoryProposalStore {
  const proposals: ConfigProposal[] = [];
  return {
    create(proposal) {
      proposals.push(proposal);
      return Promise.resolve();
    },
    list: () => [...proposals],
  };
}
