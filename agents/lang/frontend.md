---
language: frontend
---

# Frontend specialist profile (React 19 / Next.js App Router)

## Commands
- Package manager: `pnpm` (preferred) or `npm`. Build: `pnpm build`. Lint: `pnpm lint` (eslint). Format: `prettier`. Unit/component tests: `pnpm test` (vitest). E2E: `playwright test`. Coverage target ≥ 80%.

## Testing (MANDATORY file organization)
Tests are co-located beside source as `*.test.tsx` / `*.spec.ts` (e.g. `Button.tsx` → `Button.test.tsx`). Never inline test code in production components. Use `vitest` + React Testing Library for components; `playwright` for user-flow E2E.

## Idioms (React 19.3+ / Next.js App Router / TypeScript strict)
- Default to Server Components; reach for `"use client"` only for interactivity/event handlers. Use Server Actions for mutations (not hand-rolled API routes).
- Rely on the React Compiler for memoization — do NOT sprinkle `useMemo`/`useCallback`/`memo` manually unless profiling proves it.
- TypeScript `strict: true`. Follow existing design tokens / component conventions in the repo; match the surrounding style.
- Keep hydration-safe logic out of render; isolate client-only state in leaf components.
