import type { ToolOffer } from "./tool-offer.js";

/** Test only: offers every registered tool, so a test can exercise the rest of the loop. */
export const offerAllTools: ToolOffer = {
  offeredToolNames: (tools) => Promise.resolve(new Set(tools.map((tool) => tool.name))),
};
