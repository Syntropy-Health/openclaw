/**
 * Canonical memory-partition / scope-key derivation shared by the identity
 * extensions (oc-hygiene / graphiti-memory P4).
 *
 * This is the SINGLE SOURCE OF TRUTH for "which key partitions a user's memory".
 * It was previously computed independently — and identically — in two places:
 *   - auth-memory-gate `scope.ts` (the `scope_key` of the `[MEMORY_SCOPE]` block
 *     it injects for downstream memory plugins), and
 *   - memory-graphiti `identity.ts` (`resolveIdentityScopeKey`, the groupId for
 *     the `identity` strategy).
 * Consolidating the rule here means the memory partition key and the identity
 * scope key can never drift, and the contract lives in one documented place.
 *
 * NOTE — the two are PARALLEL, not chained: the OpenClaw before_agent_start hook
 * chain passes the same (event, ctx) to every hook and only merges each hook's
 * `prependContext` into the final result, so memory-graphiti's hook never sees
 * auth-memory-gate's emitted `[MEMORY_SCOPE]` block. A shared resolver (rather
 * than parsing that block) is therefore the correct way to share the contract.
 */

/** The minimal identity shape the scope key is derived from. */
export type ScopeKeyIdentity = {
  /** Cross-channel external id (from the JWT `sub`); null for channel-only users. */
  external_id: string | null;
  /** Internal user UUID (always present). */
  id: string;
};

/**
 * Derive the canonical scope/partition key for a resolved identity.
 *
 * ASSUMPTION (the ONE line to revisit on Syntropy-Journals #9–#11 / the shared
 * `user_id`-keyed contract): prefer the cross-channel `external_id` (JWT `sub`),
 * falling back to the internal user UUID for channel-only users. When SJ settles
 * the user_id-vs-external_id precedence of the shared contract, this is the
 * single place that changes.
 */
export function deriveScopeKey(identity: ScopeKeyIdentity): string {
  return identity.external_id ?? identity.id;
}
