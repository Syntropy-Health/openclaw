/**
 * Runs the one memory read-surface contract (testing/memory-client.contract.ts)
 * against every client (A&D §4.1, G4).
 */
import { FakeMemoryClient } from "./testing/fake-memory-client.js";
import { runMemoryClientContract } from "./testing/memory-client.contract.js";

runMemoryClientContract({
  name: "FakeMemoryClient",
  make: () => {
    const client = new FakeMemoryClient();
    return { client, seed: (g, facts) => client.seed(g, facts) };
  },
});
