/**
 * Runs the one memory read-surface contract (testing/memory-client.contract.ts)
 * against every client (A&D §4.1, G4): the in-memory fake, ZepCloudClient over
 * a fake SDK object, and GraphitiRestClient over a graphiti-server HTTP fixture
 * (recorded shapes, no network).
 */
import { GraphitiRestClient } from "./client.js";
import { FakeMemoryClient } from "./testing/fake-memory-client.js";
import { createGraphitiServerFake } from "./testing/graphiti-server-fake.js";
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

runMemoryClientContract({
  name: "GraphitiRestClient (graphiti-server fixture)",
  make: () => {
    const server = createGraphitiServerFake();
    const client = new GraphitiRestClient(server.base, { fetch: server.fetch });
    return { client, seed: server.seed };
  },
});
