---
language: go
---

# Go specialist profile

## Commands
- Build: `go build ./...`. Lint: `go vet ./...` (and `golangci-lint run` if configured). Format: `gofmt -s -w .` (or `go tool gofmt` on 1.26+). Test: `go test ./...`. Coverage: `go test -cover ./...` (target ≥ 80%). Benchmarks: `go test -bench . -benchmem`.

## Version discipline (read FIRST)
Detect the project's Go version from `go.mod` (or `go.work`) before writing code, and use ONLY language features and stdlib additions available up to and including that version. When the version is not pinned, assume at least Go 1.22. Modern idioms below are authoritative: apply them even when nearby code or repo convention uses an older pattern; skip one only when it would not compile on the target version or would change behavior. (Source of truth: JetBrains Modern Go Guidelines, vendored at docs/references/go-modern-guidelines in the super-dev repo.)

## Testing (MANDATORY file organization)
Tests go in `*_test.go` files in the SAME package directory as the code under test (`foo.go` → `foo_test.go`). Always use table-driven tests with `t.Run` subtests. Use `t.Context()` (Go 1.24+) for test contexts, `b.Loop()` for benchmarks (Go 1.24+), and `t.Setenv` for env. Never read the clock or network in unit tests without injection.

## Idioms — always (any supported Go)
- Errors are values: wrap with `fmt.Errorf("context: %w", err)`, check with `errors.Is`/`errors.As` (never `err == target`). Never ignore returned errors.
- `time.Since(start)` / `time.Until(deadline)`, never `time.Now().Sub(...)`.
- Accept interfaces, return structs. Define interfaces at the consumer site, 1–3 methods max. Use `any`, never `interface{}`.
- Concurrency: `context.Context` as first arg for cancellation, `signal.NotifyContext` for graceful shutdown, `errgroup.Group` for fan-out, `sync.WaitGroup.Go(fn)` for tracked goroutines (1.25+ — replaces manual `Add`/`defer Done`).
- Structured logging with `slog`; never `fmt.Println` in production paths.

## Idioms — Go 1.21+ (baseline stdlib helpers; prefer over hand-written loops)
- `min(a,b)` / `max(a,b)` builtins instead of if-else clamps; `clear(m)` instead of delete-loops.
- `slices.Contains` / `slices.Index` / `slices.IndexFunc` instead of manual search loops.
- `slices.Sort` instead of `sort.Ints`/`sort.Strings`; `slices.SortFunc(items, func(a, b T) int { return cmp.Compare(a.X, b.X) })` instead of `sort.Slice`.
- `slices.Max`/`slices.Min`/`slices.Reverse`/`slices.Compact`/`slices.Clip`/`slices.Clone` instead of hand-written scans, swap loops, and `append([]T(nil), s...)`.
- `maps.Clone`/`maps.Copy`/`maps.DeleteFunc` instead of copy/delete loops.
- `sync.OnceFunc(f)` instead of `sync.Once` + wrapper closure; `sync.OnceValue(f)` for memoization.
- `context.AfterFunc(ctx, cleanup)` instead of a goroutine waiting on `ctx.Done()`; `context.WithCancelCause`/`WithTimeoutCause` + `context.Cause` when the cancellation reason matters.
- `strings.Cut`/`bytes.Cut` instead of `Index` + slicing; `strings.CutPrefix`/`CutSuffix` (1.20+) instead of `HasPrefix` + `TrimPrefix`; `strings.Clone`/`bytes.Clone` (1.20+) for copies; `errors.Join(err1, err2)` (1.20+) instead of `fmt.Errorf("%v; %w", ...)`.
- Typed atomics: `atomic.Bool`/`atomic.Int64`/`atomic.Pointer[T]`, never `atomic.StoreInt32(&x, ...)` or `unsafe.Pointer`.

## Idioms — Go 1.22+
- `for i := range n` instead of `for i := 0; i < n; i++` (also `range len(s)`).
- Loop variables are per-iteration: do NOT add `v := v` copies before closures/goroutines/`&v`; use `&slice[i]` only when the original element pointer is required.
- `cmp.Or(a, b, c)` for first-non-zero fallback chains (note: all args evaluate eagerly).
- `reflect.TypeFor[T]()` instead of `reflect.TypeOf((*T)(nil)).Elem()`.
- `http.ServeMux` method-aware patterns and `r.PathValue("id")`: `mux.HandleFunc("GET /api/users/{id}", h)` — no manual method checks or prefix trimming. `os.OpenRoot` for path-traversal-safe file I/O.

## Idioms — Go 1.23+
- Range-over-func: `for k := range maps.Keys(m)` / `maps.Values(m)` instead of allocating slices to iterate; `slices.Collect(iter)` when a slice is required; `slices.Sorted(maps.Keys(m))` for deterministic output (also sorted imports).
- `for part := range strings.SplitSeq(s, ",")` / `bytes.FieldsSeq` instead of `range strings.Split(...)` when only iterating.
- `time.Tick(d)` is GC-recoverable since 1.23 — fine for simple forever loops; `time.NewTicker` only when you need `Stop`/`Reset`.

## Idioms — Go 1.24+
- `json:"...,omitzero"` tags for bool/numeric/struct/time fields whose zero value means absent; keep `omitempty` for strings/slices/maps.
- `wg.Go(func() {...})` for WaitGroup-tracked goroutines.

## Idioms — Go 1.26+
- `new(value)` for pointer fields/args (`Timeout: new(30)`) instead of `Ptr`-helper functions or temp variables.
- `errors.AsType[*os.PathError](err)` instead of `var e *T; errors.As(err, &e)`.

## Idioms — Go 1.27+ (only when go.mod allows)
- `encoding/json/v2` for NEW JSON code (stricter defaults: rejects invalid UTF-8/duplicate names, nil slices → `[]`); leave existing `encoding/json` code unchanged unless migration is requested.
- `strings.CutLast`/`bytes.CutLast` instead of `LastIndex` + slicing; `net/url` `URL.Clone`/`Values.Clone` instead of manual deep copies; stdlib `uuid` package instead of third-party; promoted struct fields set directly in keyed literals (`Document{CreatedBy: "alice"}` for embedded `AuditInfo`); generic methods (`func (s Set[T]) Map[U any](...)`) instead of package-level generic helpers when the operation belongs to the type.
