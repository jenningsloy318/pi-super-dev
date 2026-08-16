# DSH-02 — The Cordis Framework and Its Paper: "A Programming Paradigm for Spatiotemporal Composability"

Status: reference — dsh research series

Sources analyzed (read in full):
- Paper: `docs/references/cordiverse-paper/paper.pdf` (Shi, Zhang, Cui — PKU & DeepSeek-AI, draft 2026-08-13; 8 sections, ~80 pp.)
- Primer: `docs/references/deepseek-harness/docs/cordis-primer.md`
- Tutorial: `docs/references/deepseek-harness/docs/cordis-tutorial/index.md` + chapters 01–07
- API reference: `docs/references/deepseek-harness/docs/cordis-api/{context,events,fiber,registry,service,inherited}.md`
- Vendored implementation: `docs/references/deepseek-harness/vendor/cordis/src/{context,events,fiber,registry,reflect,service}.ts` (v4.0.0-rc.7, vendored + rescoped per `docs/rescope.md`)

All repo paths below are relative to `docs/references/deepseek-harness/`.

---

## 1. Overview

Cordis is the plugin framework underneath DeepSeek Harness (dsh), and it is unusual among
production frameworks in having a formal semantics paper written before/alongside the 4th
major rewrite. The paper's thesis: *dynamic composition* — loading, unloading, and
reconfiguring components at runtime — has two orthogonal dimensions that map exactly onto two
classical type-theory constructs:

1. **Temporal composability** (remove a component ⇒ its modifications to the shared
   environment are completely reversed) = **effects**, lifted from compile-time annotations to
   *revertible runtime effects*: every context transformation returns an explicit inverse the
   runtime tracks.
2. **Spatial composability** (declare/discover/resolve inter-component dependencies reactively)
   = **coeffects**, lifted to *reactive coeffects*: each context change is classified against a
   component's dependency specification as activating / deactivating / neutral.

Unifying the two carriers into one first-class **context type** Γ∞ "constitutes a programming
paradigm in its own right" (§3.3.3) — the paper's claim to be more than a library.

The motivating failures are concrete and measured (§1.2): VSCode's extension host cannot
unload any of the 87/100 top extensions that contain executable code without a host restart;
only 7/100 declare inter-extension dependencies because `getExtension(...).exports` is untyped
`any`; the coarse-grained workaround (process restart / container orchestrator) discards
process-local state that takes "seconds to minutes" to rebuild. Self-evolving agent harnesses
are named as the second motivating case: an agent that rewrites its own components "with
limited or no human oversight" cannot tolerate restart-per-mutation, and a faulty
self-modification "can disable the very process needed to recover."

In dsh, the payoff is architectural: "There is no privileged core to patch" — the model
adapter, tool registry, session log, and even the agent loop are plugins
(`docs/architecture.md:13-15`), so every part is replaceable from configuration.

## 2. Mechanisms

### 2.1 Revertible effects (paper §3.1 → runtime `ctx.effect`)

The formal spine, stated compactly:

- **Effect context** `∂Γ ≔ Γ × (Γ → Γ)` — current state γ plus an *accumulator* φ, the
  composite of inverses of effects performed so far (Def. 2).
- **track** `trackΓ(f,g)(γ,φ) = (f(γ), φ ∘ g)` — applies the forward map and composes the
  inverse onto the accumulator; a monoid homomorphism from the *twisted composition monoid*
  `𝔗Γ` where `(f₁,g₁)∘(f₂,g₂) ≔ (f₁∘f₂, g₂∘g₁)` (Defs. 1–3, Thms. 4–5).
- **recover** `recoverΓ(γ,φ) = (φ(γ), id)` — runs the accumulator and resets it (Def. 6).
  *Soundness invariant*: `φ(γ) ≃ γ₀` (Thm. 7).
- Because a priori inverses are unrealistic, the model upgrades to **effect functions**
  `𝔈Γ ≔ Γ → Γ × (Γ → Γ)` with per-state witnesses `𝔈Γ*` (Def. 8): the inverse is supplied
  *at the point of application* and only held to reverting that one transition
  (`g(δ) = γ`), unconstrained elsewhere. Composition `⋄` composes forward maps and
  accumulates inverses in reverse (Def. 9, Thms. 10–11).
- **Independence** (Def. 19): two effects are independent when their transformation monoids
  commute and neither disturbs the inverse the other yields. Under independence, inverses can
  be applied in *any permutation* and still reach γ₀ (Cor. 21) — this is what lets one
  component unload while others stand, not just LIFO unwinding.
- **Effect iterators** (Def. 51): `𝔈Γiter ≔ μI. Γ → Γ × (Γ→Γ) × Maybe(I)` — a reified
  delimited continuation ("the structure mainstream languages expose through `yield`") so a
  long activation can be interrupted *between* effects and partially rolled back.

Runtime realization (paper Algorithm 1 = `vendor/cordis/src/fiber.ts` `EffectRunner`):

- `ctx.effect(callback)` is **the sole mutation primitive**: coeffect provision, plugin
  instantiation, and every other context-mutating operation reduce to it, "so any operation
  performed through the context is automatically tracked and recovered" (§5.1.1).
- The `execute` engine drives the callback as an iterator; each yielded disposer is
  *prepended* (`inverse ← value ∘ inverse`) → LIFO recovery. A guard callback is consulted
  before each step; the fiber-level guard is "target view still stable," the effect-level
  guard is an `armed` flag making disposal idempotent ("firing twice would apply an inverse at
  a state no application of the effect produced").
- API surface (`docs/cordis-api/fiber.md:11-44`): "disposers … run (in reverse order) either
  when the returned disposer is called or when the fiber unloads"; double-dispose is a no-op;
  `CordisError('INACTIVE_EFFECT')` on a dead fiber (code table at `vendor/cordis/src/fiber.ts:170-174`).

### 2.2 Reactive coeffects (paper §3.2 → runtime `ctx.get/set/isolate/intercept`)

- **Coeffect context** `Σ ≔ (k:K) ⇀ 𝒱k` — a dependent partial function from typed keys to
  values (Def. 22). `get` requires `k ∈ dom(σ)`; `set(k,v)` returns
  `(σ[k↦v], λσ'.σ'∖k)` — *set is itself a witnessed effect function* `𝔈Σ*`, so dependency
  registration inherits tracking and revertibility (Def. 23). This is the paper's central
  "synergy": **coeffect operations are effects, and effects are revertible.**
- **Specification and notification** (Defs. 25–26): a spec `d ⊆ K`; satisfaction `σ ⊧ d ≔
  ∀k∈d. k∈dom(σ)` is decidable; every transition is classified `notify_d(σ,σ') ∈
  {activating, deactivating, neutral}`. "The reactive invariant is: an activating transition
  triggers execution of the component's effects … a deactivating transition triggers recovery
  by applying the accumulator." Reactivity is cheap because "all mutations to σ pass through
  effect functions … changes to satisfaction are detectable at each effect boundary."
- **Isolation** (Def. 28–29): `Σiso ≔ (K⇀R) × ((r:R)⇀𝒱r)` — a two-layer realm table lets the
  same key resolve to different values in different contexts; "essentially … runtime ad-hoc
  polymorphism." Isolation is a *derived realization*: it derives a child context, writes
  nothing shared, so "recovery discards the derived context along with the adjustment" — no
  inverse needed.
- **Interception** (Defs. 30–31): `Σinter` merges context-carried metadata `ι` with
  component-declared metadata `d(k)` under a per-key monoid `(ℳk, ⊕k, εk)`; the merge is
  right-biased so "an enclosing context [can] constrain how a component uses a coeffect
  without modifying that component" — the formal hook for capability-style access control
  (§6.3).

Runtime realization (§5.1.2, Algorithm 2–3):

- Three symbol-keyed slots per context: `@@store` (realm→value), `@@isolate` (key→realm),
  `@@intercept` (key→metadata). `get` resolves `k → ρ(k) → σ(ρ(k))`; `set` writes under the
  realm symbol and its disposer deletes it — both ends call `notify`.
- `notify(ctx, keys)` walks all live fibers, refreshes any whose `inject` contains a changed
  key *and* resolves it to the same realm, and returns the affected fibers so the caller can
  await them. "A binding counts as available to a dependent only while the fiber that
  installed it is ACTIVE … this is what makes a withdrawal visible to dependents one step
  before it happens."
- Runtime API: `ctx.isolate(name, label?)` — "Passing the same `label` to two `isolate()`
  calls joins their scopes" (`docs/cordis-api/context.md:39-66`, source
  `vendor/cordis/src/context.ts`); `ctx.intercept(name, config)` — child context with merged
  intercept entry (`docs/cordis-api/context.md:68-90`).

### 2.3 The unified context Γ∞ and observational equivalence (paper §3.3)

- `Γ∞ ≔ μΓ. Γ × (Γ→Γ) × Σ` (Def. 32) — a recursive type carrying state, accumulator, and
  coeffect table. "Effect maps 𝔈Γ∞ to itself, unifying the ∂-tower into a single
  self-similar type." Since the value family 𝒱 is unconstrained, "Σ subsumes all shared
  mutable states, not just inter-component dependencies." Hierarchical composition is the
  literal plug-in metaphor: loading = applying effects, unloading = recovering them, "a
  parent context aggregates and manages the effects of all its children."
- **Observational equivalence ≃** (Defs. 33–39): recovery is an idealization — `free` does
  not restore heap layout; a generative name is not un-generated. So all equalities are read
  up to an equivalence assembled from each key's own ≃k, where ≃k must be *no finer than
  indistinguishability under the key's published operations* (Lemma 35: ≈ is the coarsest
  admissible relation). Theorem 40 — operations at distinct keys are automatically
  independent — plus commutative keys (e.g. registration tables: "two registrations in either
  order leave a table that answers every test alike") yield Theorem 42: coeffect-mediated
  effect functions over commutative keys are independent, which is what *discharges* the
  independence hypothesis of §3.1.3 in practice. Non-commutative keys exist: "a key whose
  value is an ordered chain is not [commutative], since a middleware inserted before another
  sees a different request" — order-sensitivity is deliberately pushed to the coeffect side,
  where providers impose it, rather than hoping effect ordering suffices.

### 2.4 The calculus of dynamic composition (paper §4)

Objects: a **component** `(d, p, e)` = dependencies declared, keys provided (provisions of
distinct fibers must be disjoint — single-source), witnessed effect function (Def. 43). A
**fiber** = one instantiation with parent π, own table σ, retirement flag τ, lifecycle θ
carrying the accumulator g and the **committed view** ω (Def. 44). The **registry** holds
fibers; the coeffect context is *derived*, not stored: `σγ ≔ ⋃ active fibers' tables`
(Def. 45).

The lifecycle is driven by comparing **target view** (what each declared key *should* resolve
to, i.e. provider fiber ids) against the committed view. Ten rules (Table 1):

- Orchestration: `O-Insert` / `O-Retire` / `O-Remove` (external requests; retire is
  unconditional because "retiring is a request"; removal requires no dependents and no
  children — "removing it earlier would discard the accumulator and leak").
- Activation: `L-Begin → L-Iter* → L-Finish`, with `L-Divert` (target turned mid-transition ⇒
  abort or land the in-flight iteration) and `L-Raise` (failure ⇒ route through Unloading,
  "recovers before it records," arriving `Inactive(ξ)` with *nothing installed*; a failed
  fiber is never re-entered — "withholds a fiber whose effect function has shown itself to be
  unsound … rather than retrying it against an unchanged environment").
- Deactivation is split in two — the subtlest rule in the paper: `L-Leave` marks the fiber
  Unloading (it stops *providing* — its table leaves σγ — but its committed view stays, so its
  own teardown can still read the dependency it is losing: "closing a connection pool
  typically means handing the connections back to whatever provided them"), and `L-Unload`
  applies the accumulator only under the guard `¬reliedₙ(γ)` (no other installed fiber's
  committed view names it). "A guard of this kind ordinarily deadlocks. What keeps it from
  doing so is Unloading together with σγ being the union over Active fibers alone" — once a
  provider is Unloading, dependents' targets turn ⊥ and they cascade out. Progress (Thm. 66)
  turns this into no-deadlock + termination under an acyclic precedence relation.

Metatheory (global composability):

- **Preservation** (Thm. 59): well-formedness — parent pointers land in the registry,
  provisions disjoint, committed views total and only naming installed fibers — is invariant
  under all ten rules; "the guard on L-Unload is what carries clauses (3) and (4)."
- **Recovery exactness** (Thm. 61): under pairwise independence, applying fiber n's
  accumulator at any point of its episode yields "up to the control fields, the state those
  same steps would have produced" — running an inverse "withdraws the fiber's contribution
  and nothing else." Corollary 62: terminal recovery for any outcome including failure.
- **Ordering** (Thm. 63): providers activate before dependents; a provider's binding stays
  readable to a dependent for the dependent's entire episode ("σₙ(k) constant"), and the
  provider's episode strictly contains the dependent's.
- **Resolution coherence** (Thm. 64): every iteration of a transition runs against the one
  committed resolution — or the transition diverts.
- **Progress** (Thm. 66): with ≺ acyclic, bounded iteration length, finitely many fibers —
  no deadlock and `S(n) ≤ (K+4)(V(n)+1)` step bounds; "every maximal sequence of lifecycle
  steps ends in a quiescent state."
- **Confluence** (Thm. 73, the capstone): with independence and totality-on-provision, any
  dynamic history converges to "the one the same insertions and retirements would have
  produced had each component that ends up active been loaded once, in dependency order, and
  none ever unloaded" — "the analogue, for dynamic composition, of the consistency with a
  from-scratch evaluation that change propagation establishes for incremental computation."
  This is the theorem that "licenses reasoning about a Cordis application as though it were
  statically assembled." Failure is explicitly excluded as "a genuine source of divergence" —
  honestly delimited.

### 2.5 Implementation: core library (paper §5.1 → vendored source)

Theory→runtime correspondence (paper Table 2) verified against the vendored source:

| Paper | Runtime | Source |
|---|---|---|
| Γ∞ / γ | `Context` proxy | `vendor/cordis/src/context.ts:42` |
| fiber ⟨d,p,e,π,σ,τ,θ⟩ | `Fiber` class | `vendor/cordis/src/fiber.ts:184` |
| lifecycle θ | `FiberState` enum PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING | `vendor/cordis/src/fiber.ts:140-160` |
| d (spec) | `fiber.inject` (Dict) | `vendor/cordis/src/fiber.ts` (constructor) |
| accumulator g / recover | `fiber.dispose` / `_disposables` | `vendor/cordis/src/fiber.ts:680-692` |
| ω committed view | `fiber.store` — "Snapshot of required service implementations while loaded" | `docs/cordis-api/fiber.md:113-122` |
| inertia / Future | `fiber.inertia` — "The in-flight load/unload transition" | `docs/cordis-api/fiber.md:124-133` |
| provider_k | an `Impl` whose provider fiber is ACTIVE | `vendor/cordis/src/fiber.ts:600-624` |
| target(γ,n) | epoch digest `uid:uid…` recomputed on service writes | `vendor/cordis/src/fiber.ts:613-633` |

Two mechanisms deserve code-level attention:

1. **Epoch = target view digest.** `_setEpoch` builds a string of provider uids; any change
   flips the fiber to reload (`_reload`) or unload (`_unload`), and both check the epoch again
   on completion — "once entered, a transition runs to completion before the system responds
   to a target-state change" (the inertial state machine of §4.3.3, mutual chaining of
   reload↔unload at `vendor/cordis/src/fiber.ts:655-684`). Uids come from a monotonic
   registry counter (`vendor/cordis/src/registry.ts:196-208`), so "a provider that is
   replaced cannot be mistaken for the one it replaced, even when the two provide equal
   values." Consequence worth knowing: **an in-place value overwrite is not observed** — a
   provider wanting its replacement to propagate must withdraw and re-install the binding.
2. **Guard on L-Unload.** Paper Algorithm 5, line 25: `await all(notify(...))` — unload drains
   notified dependents *before* running `fiber.dispose()`, and "the wait sits ahead of the
   whole recovery rather than inside one of the inverses being waited on."

Proxy-mediated access (Algorithm 6, §5.1.4): `ctx.tools` resolves by walking up the fiber
chain — first committed binding wins; a declared-but-uncommitted key throws
`INACTIVE_ACCESS`; an undeclared key throws `UNDECLARED_ACCESS`. Unlike bare `ctx.get`
(returns-or-nothing), the proxy "enforces the coeffect specification d at the point of use."
The paper notes this is "structurally similar to capability-based security … the inject
declaration acts as a capability request, and the context proxy acts as a capability
mediator," and that the complete capability set "is known before it runs, letting the
orchestrator review and approve them at load time."

### 2.6 Loader and HMR (paper §5.2)

- **Entries** (Def. 74): id / url / isolate / intercept / config / disabled. The paper's
  justification is elegant: "what supports a fiber is exactly what an entry records. The
  support set of Definition 67 reads τ, π, d, and p and nothing else, and an entry gives all
  four."
- **Reconciliation** is per-field minimal surgery: id/url → rebuild; isolate → reassign
  realms (Algorithm 7 uses per-key *delimiter* tags to decide whether a binding is the
  entry's own and must move with it); intercept → in place ("consulted at read time and
  needs no reload"); config → handed to the component (groups diff child lists by id);
  disabled → unload/reload. Soundness leans directly on the metatheory: confluence (final
  state is a function of final config), progress (reconciliation completes), terminal
  recovery (rebuilding one entry leaves neighbors untouched), and ordering (no load order to
  arrange — "a fiber whose declared keys are not yet provided waits at its L-Begin … so the
  loader loads modules concurrently").
- **HMR** needs "no developer-annotated acceptance boundaries, as opposed to Webpack or Vite
  HMR," because a fiber already bounds all of its component's effects. Three phases:
  module classification (fixed-point over the import graph; cycles "default to declined"),
  stale-entry detection (dependency trees reaching accepted modules), transactional reload
  (invalidate caches with backup; on import failure restore caches and rebuild every stale
  entry from backup — "the system never enters a half-reloaded state").

### 2.7 Mapping to the primer's five ideas, and the event system

`docs/cordis-primer.md` distills Cordis into: plugin = Service object; context = service
repository; `inject` declares dependencies ("load order is expressed through service
requirements rather than manual boot sequencing"); typed events with per-mode dispatch;
registrations are reversible effects ("reload and teardown unwind them predictably"). Each is
the ergonomic shadow of a formal construct above: inject ↔ d; ctx keys ↔ get/Σ; reversible
effects ↔ 𝔈*; events ↔ interception/waterfall seams.

**Dispatch modes — a documented contract.** The primer's table lists four (emit, waterfall,
parallel, serial), but the tutorial (`docs/cordis-tutorial/04-events.md:82-90`) and generated
API (`docs/cordis-api/events.md:193`) list **five**, adding `bail` (synchronous serial:
"calling listeners in order until one bails"; first non-null/false/undefined return wins).
Dispatch mode is "part of the event's public contract. New harness events document it with an
`@mode` tag so the generated catalog can check declarations against dispatch sites." Runtime:
`vendor/cordis/src/events.ts:34` region; harness waterfalls include `agent/request` (replace
model-call config) and `approval/request` (policy answers instead of the user) — the
mechanism dsh's whole "capability seam" design rests on (`docs/capability-seams.md`).

Discipline worth copying verbatim: "**a waterfall listener that only observes or annotates
must call `next()`**; returning without it is a deliberate short-circuit. Forgetting `next()`
in a logging listener silently swallows the default behavior for everyone downstream."

## 3. Design decisions & trade-offs

1. **One-sided inverses, author-supplied, runtime-unverified.** The runtime tracks inverses
   but "what the operation does not check is the witness … that the inverse recovers the
   effect it accompanies is an obligation on the component author rather than a property the
   runtime verifies" (§5.1.1). Trade: enormous expressiveness (any compensating action) for a
   trust boundary placed at every plugin author. dsh mitigates operationally with
   package-owned runtime invariants (`docs/subsystems/invariants.md`: a `ctx.invariants`
   registry where "every workspace package publishes a `./invariant` companion plugin" —
   assertions may target "authoritative event streams or mutable data, never service or
   method presence").
2. **In-place vs derived realization.** Mutations that write shared state carry inverses;
   isolation/interception derive child contexts with identity inverses ("recovery discards
   the derived context"). An imperative host chooses per operation (§5.1.2, Def. 27).
3. **Order-sensitivity pushed to coeffects.** Where effects commute (registration tables),
   unload order is free (Cor. 21); where they do not (middleware chains), the framework does
   not pretend — order is imposed by provider/dependent relations (§3.3.2's closing
   argument). *But* the shipped runtime relaxes strict LIFO for teardown: tutorial ch.2 warns
   "disposers start in reverse registration order, but multiple **async** disposers run
   concurrently. If teardown steps must run in sequence, keep them in one disposer" —
   confirmed in source: `_unload` runs `Promise.all(this._disposables.clear().map(...))`
   (`vendor/cordis/src/fiber.ts:682-684`), i.e. disposers are *started* LIFO but awaited
   concurrently. This is a deliberate speed/ergonomics deviation from the formal LIFO of
   Theorem 16; authors must fold ordered teardown into one disposer.
4. **Single-source provisions.** One provider per key, enforced at insertion (`O-Insert`
   premise). Multiplexing (load balancing, rolling updates, cross-process) is delegated to a
   *service broker* component pattern (§6.2) rather than built into the model — "updating a
   backing provider leaves the broker in place, so consumers see no change … and no reload is
   triggered." Trade: model stays simple; common infra needs become explicit user-level
   components.
5. **Nominal, unversioned linking.** Dependencies link by key identity only; the paper is
   frank about interface drift and key collision and surveys three fixes (key namespacing /
   peer dependencies / structural subtyping), adopting peer deps today and calling a unified
   versioned model "an open problem" (§6.6). Service names "live in one flat namespace per
   application" (tutorial ch.3) — collision risk is real in an open ecosystem.
6. **Cycles = permanent silence, by design.** A dependency cycle "simply leaves the involved
   components permanently inactive … predictable from the declarations alone, so a runtime
   can report it when components are loaded" (§6.5). The prescribed fix is decomposition into
   integration components — with an honest cost note: pairs of interacting components can
   grow "quadradratically" in count, mitigated by bundling/conventions/scaffolding.
7. **System boundary honesty (§6.1).** Inside the boundary: exclusively-modifiable,
   restorable locations. Outside: operations act as idΓ — untracked, unrecovered. Emissions
   (bytes written, datagrams sent) cross the boundary; recovery options are *withholding*
   (output-commit) or *compensation* (delete-the-file / refund-the-charge), and compensation's
   coarser equivalence must re-establish the commutation proofs. This is the paper's clearest
   "what we do NOT guarantee" statement.
8. **Language requirements (§6.4).** Temporal: closures + an evictable module registry
   (managed runtimes; `dlopen/dlclose` natively; WASM depends on embedder — note "ES modules
   provide no public eviction API"). Spatial: typed dependency declaration (typeclasses /
   traits / TS module augmentation) + dynamic access interposition (JS Proxy / Python
   descriptors / reflection).
9. **No quantitative evaluation.** The only empirical section is the Koishi case study
   (§5.3): 4000+ community plugins over four years, unload-in-place from a console, HMR
   preserving caches/connections, cross-author dependency graphs. The paper labels it
   "an existence-and-adoption result rather than a quantitative one; measuring the
   abstraction's overhead and its effect on developer productivity … remains future work."
   `BENCHMARK.md` in the repo is about benchmarking agents *using* the harness, not the
   framework.

## 4. Evidence appendix

Paper (by section/theorem, from `docs/references/cordiverse-paper/paper.pdf`):
§1.2 VSCode 87/100 + 7/100 data, restart cost; §3.1 Defs. 1–22/Thms. 4–7 (track/recover);
Def. 8 𝔈*, Def. 9 ⋄, Thms. 10–11; §3.1.3 Def. 19 independence, Cor. 21 permutation
recovery; §3.2 Defs. 22–26 (Σ, set-as-effect, satisfaction, notify), §3.2.3 Defs. 27–31
(realization, Σiso realms, Σinter monoid metadata); §3.3 Def. 32 Γ∞, Defs. 33–39 ≃/≈, Thm.
40 distinct keys, Thm. 42 commutative keys ⇒ independence; §4 Defs. 43–52, rules O-*,
L-Begin/Iter/Finish/Divert/Raise/Leave/Unload, Table 1; §4.4 Thm. 59 preservation, Thm. 61
recovery exactness, Cor. 62, Thm. 63 ordering, Thm. 64 coherence, Thm. 66 progress (bound
S(n) ≤ (K+4)(V(n)+1)), Thm. 73 confluence; §5 Table 2 theory↔runtime, Algorithms 1–10;
§5.3 Koishi + threats-to-validity; §6.1–6.7 boundary/acquisition-emission/broker/capability/
language/granularity/versioning/co-design; §8 conclusion (agent harnesses named as the future
validation target).

Repo (relative to `docs/references/deepseek-harness/`):
- `docs/cordis-primer.md` — five ideas; dispatch table (4 modes); waterfall semantics ("veto");
  loader `!!js` expressions; "every registration should have a disposer."
- `docs/cordis-tutorial/02-lifecycle-and-effects.md` — fiber state machine diagram; "What is
  already an effect"; async-disposer concurrency caveat.
- `docs/cordis-tutorial/03-services.md` — `declare module` merging, `inject` holding PENDING,
  "Dependencies are tracked after load" (dependent unload on provider loss), optional
  `ctx.get`, flat namespace warning.
- `docs/cordis-tutorial/04-events.md` — 5-mode dispatch table; waterfall walkthrough; harness
  `agent/request`, `approval/request`.
- `docs/cordis-tutorial/06-composition-and-hmr.md` — config tree, PENDING diagnosis.
- `docs/cordis-api/context.md` — `ctx.extend/isolate/intercept` with source refs
  (`vendor/cordis/src/context.ts:42,99`).
- `docs/cordis-api/events.md` — generated signatures for emit/parallel/serial/bail/waterfall.
- `docs/cordis-api/fiber.md` — `ctx.effect` contract (reverse order, idempotent, INACTIVE_EFFECT);
  `fiber.state/uid/store/inertia/dispose`; "Snapshot of required service implementations."
- `docs/cordis-api/registry.md` — `ctx.inject(deps, cb)` = "unloaded and re-run whenever a
  required service changes"; `ctx.plugin`.
- `docs/cordis-api/inherited.md` — full inherited ctx surface + internal/* events
  (`internal/update`, `internal/get`, `internal/set` waterfalls; `loader/*`; `hmr/*`).
- `vendor/cordis/src/fiber.ts:140-160` FiberState enum; `:170-174` CordisError.INACTIVE_EFFECT;
  `:184` Fiber class; `:613-633` epoch/target digest + `_setEpoch`; `:655-684` `_reload`
  mutual chaining; `:682-692` `_unload` concurrent disposers.
- `vendor/cordis/src/registry.ts:196-208` uid counter.
- `docs/rescope.md` — vendoring rationale (peer-dependency publication would squat upstream
  names; `@deepseek-ai/cordis` 4.0.0-rc.7 mapping table).
- `docs/subsystems/invariants.md` — package-owned runtime invariant registry as the
  operational answer to the unverified-witness gap.

## 5. Critical assessment

**Strengths.**
- The two-dimension decomposition is genuinely clarifying; naming effects/coeffects as the
  *right* theoretical pair gives the runtime design justification instead of folklore. The
  "set is an effect" move (dependency registration inherits revertibility) is the single most
  elegant idea — spatial and temporal machinery become one.
- Confluence (Thm. 73) is the property plugin systems actually need and never state: dynamic
  history leaves no trace; reason about quiescent state as if statically assembled. The
  proof architecture (transposition + deletion lemmas over Table 1) is textbook-clean.
- L-Leave/L-Unload split with the `¬relied` guard solves the real teardown-ordering problem
  (consumer must be able to read the dying dependency while tearing down) that most plugin
  systems hand-wave; the guard provably cannot deadlock because visibility (σγ over Active
  fibers) precedes withdrawal.
- HMR without acceptance boundaries falls out of the fiber abstraction — a striking
  practical dividend of formal discipline.
- Production corroboration: 4000+ plugins, four years, two runtimes (server + browser
  console).

**Costs and limits.**
- *Unverified witnesses*: correctness of unload is only as good as every author's disposers.
  The formalism assumes; the runtime trusts; the harness adds an invariants registry after
  the fact. A malicious or buggy inverse is outside the model (the paper concedes this via
  the system boundary, but a *wrong* inverse is worse than an untracked effect — it can
  corrupt state a correct component depends on).
- *Async disposal breaks strict LIFO in the shipped runtime* — concurrency is faster but the
  Theorem 16 ordering guarantee silently narrows to "start order," and the mitigation
  ("keep them in one disposer") is a discipline rule, not a type.
- *Nominal linking + flat namespace + single provider per key*: ecosystem-scale versioning
  and multiplexing are pushed to broker patterns and peer-dependency conventions; the paper
  itself lists this as open.
- *Silent cycles*: mutual dependencies degrade to permanent PENDING; fine if diagnosed (ch.6
  exists), costly if not.
- *No performance numbers*: overhead of per-registration tracking, epoch recomputation on
  every service write (string digest of provider uids), and notify-fanout on every set is
  unmeasured anywhere in the paper or repo.
- *Formalism ↔ implementation drift risk*: Table 2 maps 7 calculus states onto 6 runtime
  states; the paper's guard and the runtime's drain-await are aligned but stated in different
  vocabularies; future runtime changes can silently invalidate theorem preconditions
  (independence, totality-on-provision) that no test checks.

**When NOT to use it.**
- Small fixed-composition apps: the context/registration ceremony buys nothing when nothing
  is loaded dynamically.
- Domains where emissions dominate (anything where the side effect is a sent message or
  committed transaction): the boundary means reversion is compensation, and you are back to
  saga patterns with extra bookkeeping.
- Hard real-time / hot-path systems: unmeasured bookkeeping on every mutation, plus
  string-digest epoch churn under rapid provider churn.
- Teams unwilling to maintain disposal discipline; the paradigm converts one class of bugs
  (leaks) into another (wrong inverses), and the second can be worse.

**Relevance to pi-super-dev (the series' purpose).** Three transferable lessons:
(1) *Deterministic derivable target view* — dsh's fiber reload decision is a pure function of
  provider uids, recomputed on every service write; our pipeline's equivalent (state derived
  from committed facts, compared against a target) is the same shape as our
  verdict/triage/target machinery and its "in-place overwrite is not observed" pitfall maps
  to our own stale-fingerprint lessons.
(2) *Reversible registration as the default* — every `ctx.on`/`ctx.plugin`/registry call
  returns a disposer that unwinds on unload; our extension's per-run cleanup would be
  structurally safer if every registration site were disposer-shaped.
(3) *Mode-tagged events as contract* — `@mode` tags checked by a generated catalog
  (`docs/cordis-primer.md`) is a cheap pattern for our own event/callback seams, as is the
  waterfall "observers must call next()" rule.