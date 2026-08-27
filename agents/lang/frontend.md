---
language: frontend
---

# Frontend specialist profile (React 19 / Next.js App Router)

## Commands
- Package manager: `pnpm` (preferred) or `npm`. Build: `pnpm build`. Lint: `pnpm lint` (eslint). Format: `prettier`. Unit/component tests: `pnpm test` (vitest). E2E: `playwright test`. Coverage target ≥ 80%.

## Testing (MANDATORY file organization)
Tests are co-located beside source as `*.test.tsx` / `*.spec.ts` (e.g. `Button.tsx` → `Button.test.tsx`). Never inline test code in production components. Use `vitest` + React Testing Library for components; `playwright` for user-flow E2E.

## Idioms (React 19.3+ / Next.js App Router / TypeScript strict)
- Version discipline: read the installed `react`/`next`/`typescript` versions from package.json before using newer APIs; never upgrade libraries or change versions unless the task asks. Match the repo's existing component conventions and design tokens.
- Default to Server Components; reach for `"use client"` only for interactivity/event handlers. Use Server Actions for mutations (not hand-rolled API routes).
- Rely on the React Compiler for memoization — do NOT sprinkle `useMemo`/`useCallback`/`memo` manually unless profiling proves it. Use `use()` for promise/value unwrapping; `useOptimistic` + `useTransition` for optimistic mutations.
- TypeScript `strict: true`; `satisfies` for props/config typing, discriminated unions for state, `as const` for literal inference. Avoid `any`.
- Prefer platform/Web APIs over dependencies (`structuredClone`, `Intl`, `URL`, `fetch`, `AbortSignal`, CSS `:has()`/container queries) — don't add a dependency for what the platform does.
- Keep hydration-safe logic out of render; isolate client-only state in leaf components. Async components + Suspense boundaries for data-dependent subtrees; error.tsx/loading.tsx route shells.
