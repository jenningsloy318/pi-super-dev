---
language: rust
---

# Rust specialist profile

## Commands
- Build: `cargo build` (CI: `cargo build --release`). Lint: `cargo clippy --all-targets -- -D warnings`. Format: `cargo fmt`. Test: `cargo test`. Coverage: `cargo tarpaulin` (target ≥ 80%).

## Version discipline
New crates target the LATEST stable edition (`edition = "2024"` in Cargo.toml; `resolver` not needed); using an older edition buys no compatibility. Match the workspace's existing edition when contributing to existing crates. Keep MSRV conservative — don't bump it for convenience.

## Testing (MANDATORY file organization)
Tests live in SEPARATE files, never inline with production code. Unit tests: `src/<module>/tests/*.rs` referenced via `#[cfg(test)] mod tests;` in the parent module. Integration tests: top-level `tests/` directory. Use `#[tokio::test]` for async. Prefer table-driven tests with arrays of cases.
Tests must assert GROUND TRUTH, not re-derive expected values with the same logic the code under test uses — tests that mirror implementation branches or hard-code constants back at themselves pass by construction and add noise, not value. Test observable behavior/properties instead.

### RED-phase placement (when authoring failing tests FIRST)
During the RED phase you may ONLY create test files — never production files. The unit-test placement above requires declaring `#[cfg(test)] mod tests;` inside a PRODUCTION module, which is forbidden in RED. So during RED, put ALL tests in top-level `tests/<name>.rs` integration files (they compile as separate crates and need zero production edits); a test that fails to compile because the crate or module under test does not exist yet is a VALID greenfield RED. Migrate tests into `src/<module>/tests/` only if needed during GREEN, when production edits are allowed.

## Idioms (Edition 2024 / Rust 1.85+)
- Errors: `thiserror` for libraries, `anyhow` for applications. Never `unwrap()`/`expect()` in production paths — propagate with `?`.
- Canonical error conversion: implement `From<Upstream> for MyError` once and let `?` apply it — don't repeat `.map_err(...)` at every call site (`map_err` is for foreign types or added context only).
- Panic semantics: detected programming bugs/contract violations PANIC (with a helpful message), they are not `Result` errors. Fallible-by-nature operations (parsing, I/O) return `Result`.
- Strong types: use the strongest fitting std type — `PathBuf`/`Path` (never `String`) for anything the OS consumes; newtypes (`struct UserId(String)`) to guard invariants instead of primitive obsession.
- Async: `async fn` over `fn() -> impl Future`; `tokio` runtime, `JoinSet` for concurrent tasks, `signal::ctrl_c()` for graceful shutdown. Prefer concrete types > generics > `dyn Trait` for dependencies (design escalation ladder: enum for test doubles, narrow traits only when users implement their own).
- Avoid `.clone()` to silence the borrow checker — restructure ownership instead. Accept `&str`/`&[T]`/`impl AsRef<T>` in APIs; return owned types.
- `serde` for (de)serialization; `tracing` (structured, with message templates) — never `println!`/`eprintln!` in production code.
- Macros are a LAST resort ("macros are for when you run out of language"). Prefer functions/generics/traits; when a lint must be suppressed use `#[expect(lint, reason = "...")]` (not `#[allow]`).
- Docs: document end-state behavior for USERS — no design journals, "why we chose X" essays, or self-report tables about process. First doc sentence ≈ one line; public types derive `Debug` (+ `Display` when meant to be read).
- Solve problems the Rust way when porting from other languages — do NOT transliterate OOP constructs (interfaces/hierarchies/lifetime workarounds) 1-on-1; a striking technical similarity to C#/Java code signals deeper design problems.
