---
language: go
---

# Go specialist profile

## Commands
- Build: `go build ./...`. Lint: `go vet ./...` (and `golangci-lint run` if configured). Format: `gofmt -s -w .`. Test: `go test ./...`. Coverage: `go test -cover ./...` (target ≥ 80%).

## Testing (MANDATORY file organization)
Tests go in `*_test.go` files in the SAME package directory as the code under test (`foo.go` → `foo_test.go`). Always use table-driven tests with `t.Run` subtests. Use `t.Context()` (Go 1.24+) for test contexts and `b.Loop()` for benchmarks.

## Idioms (Go 1.24+)
- Errors are values: wrap with `fmt.Errorf("context: %w", err)`, check with `errors.Is`/`errors.As`. Never ignore returned errors.
- Accept interfaces, return structs. Define interfaces at the consumer site, 1–3 methods max.
- Concurrency: `errgroup.Group` for fan-out, `signal.NotifyContext` for graceful shutdown, `context.Context` as first arg for cancellation.
- Use the standard library: `slog` for structured logging, range-over-func iterators (`iter.Seq`), `http.NewServeMux` method+path routing (`mux.HandleFunc("GET /api/users/{id}", h)`), `os.OpenRoot` for path-traversal-safe file I/O.
