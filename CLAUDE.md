# CRITICAL
1. Strictly type and never cast as a workaround. This means NO `as SomeType` casts anywhere in application code — use type guards, proper generics, or runtime-validated accessors instead.
2. Never use `// eslint-disable` comments of any kind, including `// eslint-disable-line react-hooks/exhaustive-deps`. Fix the root cause: add missing deps, wrap functions in useCallback, or restructure the effect.
3. Ask questions before implementing something you are unsure about.
3. Always use pnpm as the package manager. Never use npm or npx.
4. Use parallel agents via the Task tool whenever implementing multiple independent changes. Launch all non-overlapping tasks simultaneously in a single message.
5. The tsx dev runner does not suppress type errors — type errors are real bugs that must be fixed before considering work done. Always run `pnpm exec tsc --noEmit` (from the relevant package) to verify type safety.
6. There is no concept of withdrawal or adding funds. Funds are only used when game invites are accepted and automatically disbursed upon game end. Do not add deposit/withdraw UI. The only payment-related UI is a "Disconnect Bank" button (shown in the username dropdown if the user has a connected Stripe bank account).
7. When debugging, always add console.log statements to trace the issue, check the logs (`logs/web.log`, `logs/backend.log`, `logs/stripe.log`), and iterate. Do not guess at fixes — use logs to confirm what is actually happening before changing code.
8. When installing a library, always use the latest version (no pinned version specifier unless required). If the latest version cannot be used (e.g. peer dependency conflict, breaking API incompatibility, known bug), ALERT the user explicitly: state which version was installed and exactly why the latest could not be used.

---

# Architecture

## Monorepo
- Root: `/Users/nishant/Documents/software/tankbet`
- Package manager: pnpm workspaces
- Dev command: `pnpm dev` (overmind → web + backend + stripe listener)
- Logs: `logs/web.log`, `logs/backend.log`, `logs/stripe.log`

## packages/game-engine
- `src/constants.ts` — all game + rule constants (CELL_SIZE, TANK_SPEED, BET_AMOUNTS_CENTS, etc.)
- `src/physics.ts` — tank movement, bullet, collision, reflection
- `src/maze.ts` — DFS maze generator
- `src/renderer.ts` — Canvas 2D draw functions

## packages/shared
- `src/types.ts` — shared TS interfaces (PublicUser, PublicCharity, GameInvitePreview, etc.)
- `src/theme.ts` — color palette (`colors.primary = '#83648F'` + scale)
- `src/utils.ts` — formatCents, etc.
- `src/username.ts` — adjective-adjective-noun username generator

## apps/web (React + Vite, port 5173)
- `src/main.tsx` — ClerkProvider + BrowserRouter entry
- `src/App.tsx` — route definitions
- `src/components/AuthGuard.tsx` — checks isSignedIn + publicMetadata.onboardingComplete
- `src/components/Layout.tsx` — sidebar nav + top bar with username/donations
- `src/pages/LoginPage.tsx` — custom phone OTP flow (useSignIn, no SSO/email)
- `src/pages/OnboardingPage.tsx` — 3-step: DOB (react-datepicker) → ToS → Card
- `src/pages/HomePage.tsx` — create game, balance, add funds/withdraw
- `src/pages/GamePage.tsx` — canvas game, countdown overlay, grace period UI
- `src/pages/PracticePage.tsx` — client-only practice mode
- `src/pages/InvitePage.tsx` — invite accept/reject landing
- `src/pages/DonationsPage.tsx` — paginated donation history
- `src/pages/RulesPage.tsx`, `PolicyPage.tsx` — static content
- `src/hooks/useApi.ts` — get/post wrappers that attach Clerk JWT
- `src/api/client.ts` — apiFetch, base URL from VITE_API_URL
- `src/game/GameEngine.ts` — Colyseus client + snapshot interpolation
- `src/game/InputHandler.ts` — arrow+M (P1) / WASD+Q (P2) input
- `src/practice/PracticeEngine.ts` — client-only game loop

## apps/backend (Fastify + Colyseus, port 3001)
- `src/server.ts` — Fastify instance, CORS, clerkPlugin, route registration
- `src/prisma.ts` — PrismaClient singleton
- `src/middleware/auth.ts` — requireAuth preHandler (validates JWT, loads dbUser)
- `src/routes/users.ts` — /onboard, /me, /accept-tos, /donation-history
- `src/routes/games.ts` — create invite, fetch invite, accept, reject, fetch game
- `src/routes/payments.ts` — create-deposit, setup (Stripe customer), withdraw
- `src/routes/charities.ts` — list charities
- `src/routes/webhooks.ts` — Stripe webhook handler
- `src/rooms/TankRoom.ts` — Colyseus room, game loop at 20Hz
- `src/rooms/TankRoomState.ts` — Colyseus schema (Tank, Bullet, TankRoomState)
- `src/services/game.service.ts` — createInvite, acceptInvite, expireStaleInvites
- `src/services/pledge.service.ts` — Pledge.to disbursement
- `prisma/schema.prisma` — models: User, Charity, Game, Contribution, Disbursement, Deposit, Withdrawal

## Key env vars
- Backend: DATABASE_URL, CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PLEDGE_API_KEY, FRONTEND_URL, PORT
- Frontend: VITE_CLERK_PUBLISHABLE_KEY, VITE_STRIPE_PUBLISHABLE_KEY, VITE_API_URL, VITE_WS_URL
