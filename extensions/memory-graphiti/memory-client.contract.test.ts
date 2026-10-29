/**
 * Runs the one memory read-surface contract (testing/memory-client.contract.ts)
 * against every client (A&D §4.1, G4): the in-memory fake, and ZepCloudClient
 * over a fake SDK object (recorded shapes, no network).
 */
import { FakeMemoryClient } from "./testing/fake-memory-client.js";
import { runMemoryClientContract } from "./testing/memory-client.contract.js";
import { attachSdk, createZepSdkFake } from "./testing/zep-sdk-fake.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

runMemoryClientContract({
  name: "FakeMemoryClient",
  make: () => {
    const client = new FakeMemoryClient();
    return { client, seed: (g, facts) => client.seed(g, facts) };
  },
});

runMemoryClientContract({
  name: "ZepCloudClient (fake SDK)",
  make: () => {
    const fake = createZepSdkFake();
    const client = new ZepCloudClient("z_key");
    attachSdk(client, fake.zep);
    return { client, seed: fake.seed };
  },
});
