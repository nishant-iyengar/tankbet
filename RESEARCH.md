# TankBet: Research Findings & Open Questions

> Last updated: 2026-02-25 (Round 3). A few final clarifications needed at the bottom before the implementation plan.

---

## Decisions Locked In

| # | Decision |
|---|---|
| Auth | **Clerk** — 10k MAU free, `@clerk/fastify` plugin, phone-only, login + logout built-in |
| Networking | **Colyseus** — rooms, binary delta sync, fixed-rate game loop; link-only (no lobbies) |
| Hosting | **Vercel** (frontend) + **Railway** (backend + Postgres) |
| Wallet model | Pre-funded, **$1 increments** (any whole dollar amount) |
| Withdrawal fee | $0.25 processing fee, disclosed professionally at withdrawal time and in policy |
| Minimum withdrawal | None — user just needs enough balance to cover the $0.25 fee |
| Deposit method | **ACH (bank account) only** via Plaid — lowest dispute risk (see payments section) |
| Game server model | **Server-authoritative** (see Game State section below) |
| Grace period | **30 seconds** to reconnect before forfeit (constant lives in `packages/shared`) |
| Practice mode | Shared game engine, **client-only execution** — free movement + bullets, infinite respawn |
| Navigation | Left sidebar — Home / Practice / Rules; /policy route; policy link at bottom of sidebar |
| Bullet lifespan | **8 seconds**, infinite bounces — see note below on tuning |
| Active games | **1 per user** at any time |
| Invite flow | Creator sets bet amount → shares link → joiner sees amount + accepts/rejects → real-time update to creator |
| Game start | Opponent accepts → **3, 2, 1 countdown** → game begins (no creator "ready" confirmation needed) |
| Unauthed join | Click link → auth → Stripe onboarding → join (each step only if not already done) |
| Mobile | Game is desktop-only; detect via user agent **and** window width; lobby/wallet/auth are fully responsive |
| Login/logout | Clerk handles natively — logout in top-right user dropdown |
| Age verification | DOB collected as a dedicated step before the consent form; tracked on user model |
| State restrictions | Self-certification via ToS checkbox (no active IP geo-blocking — see explanation below) |
| Stripe compliance | Acknowledged risk — proceeding without prior Stripe approval |

---

## Payments Architecture

### Model
Users deposit any whole dollar amount ($1 minimum) via ACH bank transfer. All game outcomes update the internal ledger instantly. No Stripe charge per game. No auto top-up — manual only.

### Why ACH-only (not card)
With $1 increments, Stripe's card fee structure is unworkable: the $0.30 fixed fee alone takes **30% of a $1 deposit**. ACH at 0.8% takes $0.008 on a $1 deposit — effectively free. Additionally, ACH dispute rates in gaming are 10–20× lower than card dispute rates.

### Deposit flow
1. User enters any dollar amount (minimum $1)
2. Frontend uses Stripe's `PaymentElement` with `paymentMethodTypes: ['us_bank_account']` (ACH via Plaid)
3. First-time: Plaid OAuth bank verification (instant, ~30 seconds)
4. `PaymentIntent` created server-side → confirmed by frontend
5. On `payment_intent.succeeded` webhook → credit balance in internal ledger

### Withdrawal flow
- User requests withdrawal of any amount (no minimum — just needs enough to cover the $0.25 fee)
- Display on withdrawal screen: **"A $0.25 processing fee is applied to all withdrawals to cover bank transfer costs. This fee is passed directly to our payment processor — TankBet does not profit from it."**
- Also disclosed in /policy
- Platform initiates ACH payout via Stripe (1–3 business days, standard) or Instant Payout if debit card on file (minutes, $0.25)
- Balance debited immediately; payout initiated

### Race condition prevention
When a user **creates** an invite link, immediately **reserve** (lock) the bet amount from their balance. The reserve is released when:
- Invite is rejected by the other player
- Invite expires (link expiry duration TBD)
- Game ends (winner/loser settled)

This eliminates the edge case where balance drops between invite creation and join.

### ⚠️ Major Product Pivot: Charity Model
See the Charity Gaming Model section below — this changes the entire payments architecture.

---

## Charity Gaming Model (Major Pivot)

The product has shifted from player-to-player payouts to **charitable donations**. This is a significant and positive change.

### How It Works
- Both players select a charity (from a fixed list of 10) before the game — hidden from each other until the game ends
- Bet amounts ($1, $2, or $5) are committed from each player's balance
- The **total amount (both players' bets combined) goes to the winner's charity**
- Neither player personally profits — they are competing on behalf of a charity
- The reveal at game end (showing both charities) adds a social/emotional moment

### Why This Is a Significant Legal Improvement
This pivot largely eliminates the gambling concern:
- **No personal financial gain** — no player receives money. This removes the core legal definition of wagering.
- **Charitable donation** — contributing money via a game to a charity is not gambling under any US state's definition.
- **MCC 7995 (gambling) concern disappears** — this would more likely be classified as charitable giving or entertainment, not gambling.
- **NACHA/UIGEA concern disappears** — those rules target gambling payments. Charitable donations are explicitly unaffected.
- The earlier restricted-states list becomes largely irrelevant. Charitable gaming has its own (much lighter) regulatory framework.

### Remaining Legal Considerations (Charity Model)
- **Charity solicitation licenses**: Many US states require organizations that solicit charitable donations to register. If you're collecting and forwarding donations on behalf of charities, you may be acting as a "charitable solicitor." This varies by state and by total donation volume.
- **501(c)(3) verification**: The 10 charities should be verified 501(c)(3) organizations. Donating to a non-501(c)(3) creates tax and liability issues.
- **Tax receipts**: Donations made through the platform may be tax-deductible for users. You may need to issue donation receipts (especially above $250 per year per charity). This requires integration with the charity or a donation processing platform.
- **Platform sustainability**: The platform does not profit from this model. How does it sustain operational costs (hosting, Stripe fees, etc.)? Options: small platform fee on each game, separate subscription, or run at a loss.

### Charity Disbursement API Research

After deep research across every major option, here is the full picture:

| Platform | Server-Side API | US 501(c)(3) | Fees | Auto Tax Receipts | Dev Onboarding |
|---|---|---|---|---|---|
| **Pledge.to** ✅ | **Yes** | Yes | 5% + processing | **Yes (automated)** | Self-serve sandbox |
| **Every.org** | No (redirect only) | Yes (1M+ nonprofits) | ~2.2% + $0.30 card | Yes | Self-serve, free |
| **Stripe Connect** | Yes | Requires charity Stripe account | ~2.9% + $0.30 | **No** — must build | Self-serve |
| **Benevity** | Yes | Yes | Enterprise pricing | Yes | Enterprise only |
| **GlobalGiving** | Yes | Yes | 8–15% total | Yes | Self-serve |
| **PayPal Giving Fund** | No (redirect) | Yes | 0–1.99% + $0.49 | Only via PPGF flow | Self-serve |

**Winner: [Pledge.to](https://pledge.to)** — the only platform with a true server-side Donate API that also handles automated tax receipts for donors. 5% platform fee + standard payment processing.

**Why not Every.org despite lower fees:** Every.org has no server-side API. The game outcome triggers a donation without further user interaction — Every.org cannot do this. It requires the user to land on an external checkout page.

**Why not Stripe Connect:** Stripe Connect requires all 10 charities to individually create and connect Stripe accounts. Small nonprofits often don't have Stripe accounts, and none of them issue tax receipts automatically.

**Recommended:** Pledge.to for disbursements. Stripe for deposit processing. These are independent concerns.

### Donation Tracking (Per Latest Clarification)

The top-right shows a single number: **"$X donated"** — the user's lifetime total. Clicking it opens a history page.

Tracking rules:
- **Win**: full combined amount (your bet + opponent's bet) counted toward your total — because both go to your charity
- **Lose**: only your bet amount counted — you donated your money to the opponent's charity

Example history entries:
```
Feb 25  Won vs quick-red-fox   +$4.00 → Red Cross     (your $2 + their $2)
Feb 24  Lost vs bold-blue-bear  +$1.00 → ASPCA         (your $1)
```
Total shown: $5.00 donated lifetime.

### Updated Payment Flow (Charity Model)
1. User links bank account (ACH via Plaid) — one time during onboarding
2. User deposits funds in $1 increments to their balance
3. User creates or joins a game, selects a charity (hidden), bets $1/$2/$5 (reserved from balance)
4. Game completes → both charities revealed → internal ledger updated → donation queued for disbursement
5. Platform batches donations and disburses to charities weekly/monthly via Pledge.to API
6. Pledge.to issues tax receipts automatically to users via email

### Donation Tracking Model

Each user has a running total of money donated, shown in the top right. Clicking it opens a donation history page.

**Tracking rules:**
- **When you LOSE**: you donated your bet amount (tracked against your account, even though it goes to the winner's charity)
- **When you WIN**: tracked as the combined total (your bet + opponent's bet, both going to your charity)

This means a user's donation total = all money they've ever put into games (whether they won or lost), plus the opponent's matched amount on wins.

**Donation history entry:**
```
[Date] You won → $4 donated to Red Cross (your $2 + opponent's $2)
[Date] You lost → $2 donated to ASPCA (opponent won)
```

### Final Database Models

All models reviewed and cleaned. Winner/loser score removed (1v1 = single round, score is always 1–0 — meaningless to store). Contributions is the source of truth for all financial history.

```prisma
// ─── User ───────────────────────────────────────────────────────────────────

model User {
  id                  String    @id @default(cuid())
  clerkId             String    @unique
  username            String    @unique      // "delicious-blue-seal"
  dateOfBirth         DateTime               // collected during onboarding
  stripeCustomerId    String?               // for card deposits
  balance             Int       @default(0)  // available balance in cents
  reservedBalance     Int       @default(0)  // locked for a pending invite
  totalDonatedCents   Int       @default(0)  // denormalized — see Contribution rules
  tosAcceptedAt       DateTime?
  tosAcceptedIp       String?
  tosAcceptedVersion  String?
  tosUserAgent        String?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  gamesAsCreator      Game[]         @relation("GameCreator")
  gamesAsOpponent     Game[]         @relation("GameOpponent")
  contributions       Contribution[]
  deposits            Deposit[]
  withdrawals         Withdrawal[]
}

// ─── Charity ─────────────────────────────────────────────────────────────────

model Charity {
  id            String  @id @default(cuid())
  name          String
  ein           String  @unique   // IRS EIN
  pledgeSlug    String?           // Pledge.to identifier for disbursement API
  logoUrl       String
  website       String
  description   String            // short blurb shown in charity picker
  active        Boolean @default(true)
  createdAt     DateTime @default(now())

  contributions  Contribution[]
  disbursements  Disbursement[]
}

// ─── Game ────────────────────────────────────────────────────────────────────

model Game {
  id                String     @id @default(cuid())
  creatorId         String
  opponentId        String?
  betAmountCents    Int        // 100 | 200 | 500
  creatorCharityId  String?    // hidden until game ends
  opponentCharityId String?    // hidden until game ends
  status            GameStatus
  winnerId              String?
  loserId               String?
  winnerLivesRemaining  Int?        // 1–5 — how many lives the winner had left
  inviteToken           String     @unique
  inviteExpiresAt   DateTime   // createdAt + 2 minutes
  startedAt         DateTime?
  endedAt           DateTime?
  durationSeconds   Float?
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt

  creator           User       @relation("GameCreator",  fields: [creatorId],  references: [id])
  opponent          User?      @relation("GameOpponent", fields: [opponentId], references: [id])
  contributions     Contribution[]
}

enum GameStatus {
  PENDING_ACCEPTANCE  // invite link created, waiting for opponent to open
  IN_PROGRESS         // countdown started / active game
  COMPLETED           // normal game end
  FORFEITED           // a player disconnected past the grace period
  REJECTED            // opponent explicitly rejected the invite
  EXPIRED             // 2-minute invite window passed without acceptance
}

// ─── Contribution ────────────────────────────────────────────────────────────
//
// One row per player per completed game. Both rows point to the WINNER's charity
// (all money from a game goes to the winner's charity).
//
// netAmountCents = betAmountCents × (1 − PLEDGE_FEE) — what actually reaches charity
// e.g. $5 bet → Pledge takes 5% → $4.75 reaches charity
//
// totalDonatedCents on User update rules:
//   WINNER: += netAmountCents × 2  (their bet + loser's bet, both went to their charity)
//   LOSER:  += netAmountCents      (just their own bet, went to winner's charity)

model Contribution {
  id              String           @id @default(cuid())
  userId          String
  gameId          String
  charityId       String           // always the winner's charity
  role            ContributionRole // WINNER | LOSER
  betAmountCents  Int              // raw bet (e.g. 500)
  netAmountCents  Int              // after Pledge.to fee (e.g. 475)
  disbursementId  String?          // set when included in a batch disbursement
  createdAt       DateTime         @default(now())

  user            User             @relation(fields: [userId],         references: [id])
  game            Game             @relation(fields: [gameId],         references: [id])
  charity         Charity          @relation(fields: [charityId],      references: [id])
  disbursement    Disbursement?    @relation(fields: [disbursementId], references: [id])
}

enum ContributionRole {
  WINNER
  LOSER
}

// ─── Disbursement ────────────────────────────────────────────────────────────
//
// One row per charity per batch payout run (weekly/monthly via Pledge.to API).
// Aggregates all pending Contributions for that charity.

model Disbursement {
  id               String             @id @default(cuid())
  charityId        String
  totalAmountCents Int
  pledgeDonationId String?            @unique  // Pledge.to transaction ID
  status           DisbursementStatus
  createdAt        DateTime           @default(now())
  disbursedAt      DateTime?

  charity          Charity            @relation(fields: [charityId], references: [id])
  contributions    Contribution[]
}

enum DisbursementStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

// ─── Deposit ─────────────────────────────────────────────────────────────────
//
// Records each user card charge. Platform absorbs Stripe fees — user balance
// is credited the full requested amount. stripeFeesCents is tracked for accounting.

model Deposit {
  id                    String        @id @default(cuid())
  userId                String
  amountCents           Int           // amount user requested (credited to balance)
  stripeFeesCents       Int           // fee Stripe charged (platform absorbs)
  stripePaymentIntentId String        @unique
  status                DepositStatus
  createdAt             DateTime      @default(now())

  user                  User          @relation(fields: [userId], references: [id])
}

enum DepositStatus {
  PENDING
  SUCCEEDED
  FAILED
}

// ─── Withdrawal ──────────────────────────────────────────────────────────────

model Withdrawal {
  id                   String           @id @default(cuid())
  userId               String
  requestedAmountCents Int              // what user typed in
  feeCents             Int              @default(25)  // $0.25
  netAmountCents       Int              // requestedAmount − fee
  stripePayoutId       String?          @unique
  status               WithdrawalStatus
  createdAt            DateTime         @default(now())
  processedAt          DateTime?

  user                 User             @relation(fields: [userId], references: [id])
}

enum WithdrawalStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}
```

---

## ACH vs Card: Chargeback Risk

| | Card | ACH (Bank Account) |
|---|---|---|
| Dispute window | 120 days (Visa/MC) | 60 days (consumer) |
| Dispute fee | $15 | $15 |
| Typical dispute rate in gaming | 0.5–2%+ | 0.04–0.15% |
| Win rate for merchant | Medium-High | Low-Medium |
| Best protection | 3DS2, CVV, signed ToS | **Plaid instant verification** |

**Recommendation:** Use ACH via Plaid instant verification as primary. Dispute volume is dramatically lower. When a dispute occurs, the Plaid OAuth consent record + NACHA mandate + IP/timestamp is your strongest defense.

**ACH vs card chargebacks: Yes, they still exist.** Even with bank accounts, users can file "unauthorized" claims within 60 days. But the dispute rate is ~10–20× lower than cards for gaming platforms.

**Best dispute-defense stack:**
- Plaid instant bank verification (not microdeposits)
- Explicit NACHA mandate shown as standalone checkbox (not buried in ToS)
- Log: IP, timestamp, device fingerprint, Plaid event ID, exact authorization text hash
- 24–48hr withdrawal hold on winnings funded by new ACH deposits

---

## Game State Architecture (#7)

**Answer: Server-authoritative simulation.**

The server runs the full game loop — physics, bullet positions, collision detection, win conditions. Clients send **input events** (key down/up). The server processes input, advances state, broadcasts the result.

```
Client sends:  { type: "INPUT", keys: { up: true, left: false }, seq: 142 }
Server sends:  { tanks: [{x, y, angle}, ...], bullets: [{x, y, vx, vy, age}, ...], seq: 142 }
Client renders: interpolated between last two server snapshots
```

**This is non-negotiable for a money game.** Client-authoritative physics can be trivially manipulated (modify JS in browser → report "I won"). With money on the line, the server is the only source of truth.

For **practice mode**: the same game engine code (from `packages/game-engine`) runs entirely on the client. No Colyseus room, no server connection for gameplay. This gives full code reuse without burning server resources on single-player.

---

## Practice Mode Architecture

```
packages/
  game-engine/       ← shared: physics, maze gen, rendering, constants
    src/
      physics.ts     ← tank movement, bullet, collision, reflection
      maze.ts        ← DFS maze generator
      renderer.ts    ← Canvas 2D draw functions
      constants.ts   ← TANK_SPEED, BULLET_SPEED, GRACE_PERIOD_SECONDS, etc.

apps/
  web/
    game/            ← multiplayer: Colyseus client + game-engine
    practice/        ← solo: game-engine only, client-side loop, no server

apps/
  backend/
    rooms/
      TankRoom.ts    ← Colyseus room: input processing, server-side game-engine, state broadcast
```

Practice mode runs a `requestAnimationFrame` loop on the client using the shared `game-engine` package. One tank, full physics, can shoot itself. No backend involved.

---

## Bullet Timer: Concern

You specified: **8 seconds, infinite bounces**.

At 525 px/s over 8 seconds = **4,200px of travel** in a 832×576px maze (13×9 cells at 64px). This is significant — a bullet bounces approximately 7–10 times before expiring at a typical angle. With up to 5 bullets per tank, there can be **10 bullets on screen simultaneously**, each traveling 4,200px.

This creates a noticeably more chaotic experience than the original TankTrouble (5 bounces ≈ ~1,000px travel). This could be intentional — "bullet hell" feel — or unintentional. **Flag for your playtesting.** Easy to tune: the `BULLET_LIFETIME_SECONDS` constant in `packages/game-engine/constants.ts` controls this globally.

---

## Navigation & Information Architecture

```
Left sidebar (always visible):
  [Home]       → /          wallet balance, create game, join game
  [Practice]   → /practice  solo tank sandbox
  [Rules]      → /rules     game rules + grace period policy + bet rules
  ─────────────────────────
  [Policy]     → /policy    full legal policy (also accessible from footer)

Top right:
  Balance: $X.XX
  [username]  → dropdown: logout

Routes:
  /                   home / lobby
  /practice           practice mode
  /rules              rules tab
  /policy             full legal policy page
  /game/[id]          active game
  /invite/[token]     invite landing page (accept / reject)
  /onboarding         bank linking step (post-auth, pre-lobby)
```

---

## Railway Pricing & Spending Limits

Railway (railway.app) as of 2025–2026:

- **Free trial**: $5 of usage credits, no credit card required
- **Hobby plan**: $5/month base fee + usage-based billing
  - CPU: ~$0.000463 / vCPU-minute
  - RAM: ~$0.0000023 / MB-minute
  - A small Fastify + Colyseus server (0.5 vCPU, 512 MB, 24/7) costs roughly **$5–10/month** on top of the base fee → **~$10–15/month total**
- **Spending limits**: Railway does allow you to set a monthly spending cap in the dashboard (Settings → Billing → Spending Limit). The service will be paused if the cap is hit rather than overcharging. You can also set email alerts at a threshold.
- **Pro plan**: $20/month base + usage (adds more resources, teams, priority support)

**Postgres add-on**: ~$5/month for a small instance on Railway. Alternative: Neon (free tier, generous for small apps).

**Verify current pricing** at railway.app/pricing — this can change.

---

## Consent Form (Draft)

This should appear as a **dedicated step** during onboarding, after phone verification, before the wallet/home screen. Require a checkbox + "I Agree" button. Log: IP, timestamp, user agent, ToS version string (e.g., `v1.0-2026-02-25`).

---

### TANKBET SKILL GAMING TERMS & PARTICIPANT AGREEMENT

**Version 1.0 | Effective [Launch Date]**

**PLEASE READ THIS AGREEMENT CAREFULLY. BY CLICKING "I AGREE," YOU ARE ENTERING INTO A LEGALLY BINDING AGREEMENT.**

---

**1. Nature of Service — Skill Gaming, Not Gambling**

TankBet is a skill-based competitive gaming platform. Outcomes are determined solely by player skill, reaction time, and strategic decision-making. TankBet is not a gambling service, lottery, or game of chance. No element of luck, random number generation, or chance determines game outcomes.

**2. Eligibility**

You must be at least **18 years of age** to use TankBet. By agreeing, you confirm you are 18 or older and legally permitted to participate in skill-based gaming in your jurisdiction. TankBet services are not available to residents of the following states where skill gaming with monetary stakes may be restricted: **Arizona, Arkansas, Connecticut, Delaware, Louisiana, Montana, South Carolina, South Dakota, and Tennessee.** By agreeing, you confirm you do not reside in a restricted jurisdiction. TankBet reserves the right to update this list as laws change.

**3. Financial Risk Acknowledgment**

You acknowledge and accept that:
- Participating in wagered games carries a **risk of financial loss**.
- TankBet makes **no guarantee** that you will win any game or recover any deposited funds.
- All deposits are used exclusively for wagering on games you choose to enter.
- **TankBet is not responsible or liable for any financial losses** incurred through participation on the platform.
- Funds deposited are non-refundable once applied to a completed game.

**4. Deposits and Withdrawals**

Funds are deposited in $10 increments. A $0.25 processing fee is deducted from each withdrawal to cover payment processing costs. TankBet does not profit from processing fees; this fee is passed directly to our payment processor.

**5. Account Conduct**

You agree not to use automated tools, scripts, bots, or any mechanism that provides an unfair advantage. Any attempt to manipulate game outcomes, exploit platform vulnerabilities, or engage in fraudulent activity will result in permanent account termination and forfeiture of balance.

**6. Forfeit Policy**

A player who disconnects from an active wagered game and does not reconnect within **30 seconds** forfeits the game and the wagered amount. This policy is enforced automatically by the platform.

**7. Limitation of Liability**

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, TANKBET, ITS OWNERS, OFFICERS, AND AFFILIATES SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES ARISING FROM YOUR USE OF THE PLATFORM, INCLUDING ANY FINANCIAL LOSSES. YOUR SOLE REMEDY FOR DISSATISFACTION WITH THE PLATFORM IS TO CEASE USING IT.

**8. Dispute Resolution**

Any disputes arising from this agreement shall be resolved through binding arbitration under the rules of the American Arbitration Association. You waive the right to participate in a class action lawsuit against TankBet.

**9. Consent to Electronic Transactions**

You consent to conduct all transactions electronically. Your electronic acceptance of this agreement constitutes a legal signature.

**10. Changes to Terms**

TankBet may update these terms. You will be notified and required to re-accept material changes before continued use.

---

*By clicking "I Agree," you confirm: (1) you are 18 or older, (2) you are not a resident of a restricted state, (3) you understand the financial risks, and (4) you have read and accept all terms above.*

**[I Agree]**

---

**Data recorded at acceptance**: user ID, IP address, timestamp (UTC), user agent string, ToS version (`v1.0-2026-02-25`). Stored permanently on the `User` model. Never deleted.

---

## User Model (updated)

```prisma
model User {
  id                  String    @id @default(cuid())
  clerkId             String    @unique
  username            String    @unique  // "delicious-blue-seal"
  stripeCustomerId    String?
  stripeAccountId     String?   // Stripe Connect acct_*
  balance             Int       @default(0)  // in cents
  reservedBalance     Int       @default(0)  // locked for active invite
  tosAcceptedAt       DateTime?
  tosAcceptedIp       String?
  tosAcceptedVersion  String?
  tosUserAgent        String?
  activeGameId        String?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}
```

---

## Game Model (updated)

```prisma
model Game {
  id              String    @id @default(cuid())
  creatorId       String
  opponentId      String?
  betAmount       Int       // in cents: 100, 200, or 500
  status          GameStatus
  winnerId        String?
  loserId         String?
  winnerScore     Int?
  loserScore      Int?
  durationSeconds Float?
  inviteToken     String    @unique
  inviteExpiresAt DateTime
  startedAt       DateTime?
  endedAt         DateTime?
  createdAt       DateTime  @default(now())
}

enum GameStatus {
  PENDING_ACCEPTANCE
  ACCEPTED
  IN_PROGRESS
  COMPLETED
  REJECTED
  EXPIRED
  FORFEITED
}
```

---

## Shared Constants (`packages/game-engine/constants.ts`)

```typescript
// Game physics
export const CELL_SIZE = 64;
export const TANK_WIDTH = 38;
export const TANK_HEIGHT = 46;
export const BARREL_LENGTH = 22;
export const TANK_SPEED = 150;            // px/s
export const TANK_ROTATION_SPEED = 135;  // deg/s
export const BULLET_SPEED = 525;         // px/s
export const MAX_BULLETS_PER_TANK = 5;
export const BULLET_LIFETIME_SECONDS = 8;
export const MAZE_COLS = 13;
export const MAZE_ROWS = 9;

// Game rules
export const GRACE_PERIOD_SECONDS = 30;
export const BET_AMOUNTS_CENTS = [100, 200, 500] as const; // $1, $2, $5
export const DEPOSIT_INCREMENT_CENTS = 1000;               // $10
export const WITHDRAWAL_FEE_CENTS = 25;                    // $0.25
export const LIVES_PER_GAME = 5;
export const SERVER_TICK_HZ = 20;
export const CLIENT_FPS = 60;
export const INTERPOLATION_DELAY_MS = 100;
```

---

### ⚠️ New Legal Concern: Charity Solicitation Laws

The charity pivot introduces a *different* set of legal concerns than gambling, and they are substantial:

1. **Commercial Co-Venturer (CCV):** 22 US states require registration when a for-profit business promotes that using its service benefits a charity. Your platform almost certainly qualifies. Pre-campaign filings required.

2. **California AB 488 (effective June 2024):** California explicitly defines "Charitable Fundraising Platform" to include online gaming platforms that route donations. Requires: CA Attorney General registration, segregated bank account for donations, written charity consent, monthly disbursements within 30 days, annual reporting.

3. **Charitable Solicitation Registration:** 41 states require registration before soliciting donations from residents. An online platform is soliciting nationally by default.

**The saving grace:** Using **Pledge.to as fiscal intermediary** shifts a significant portion of this burden to them — Pledge is the entity soliciting and holding funds, not you. Their compliance coverage needs to be confirmed with them directly.

**For a personal/early-stage project:** Accept the risk, launch quietly, don't market heavily until legal is sorted. The risk is real but enforcement against small operators is rare.

---

## Remaining Open Questions (Final Round)

| # | Question | Status |
|---|---|---|
| State geo-blocking | Skip — self-certification checkbox only | ✅ Resolved |
| Bullet lifetime | **3 seconds**, infinite bounces, time is source of truth | ✅ Resolved |
| Invite link window | **2 minutes from creation** — link dies on expiry | ✅ Resolved |
| Platform sustainability | Absorb Stripe + Pledge.to fees for now | ✅ Resolved |
| Deposit method | **Credit card only** (MCC 7995 concern gone with charity model) | ✅ Resolved |
| ToS / Policy needed? | **Yes** — see note below (reframed for charitable gaming) | ✅ Resolved |

### Last Open Item: Charity List
Confirm the proposed list of 10 charities or swap any out:

### Suggested Charity List (for your consideration)

These are broadly recognized, diverse 501(c)(3) organizations. All have strong brand recognition:

| # | Charity | Category |
|---|---|---|
| 1 | American Red Cross | Disaster Relief |
| 2 | ASPCA | Animal Welfare |
| 3 | Doctors Without Borders (MSF) | International Aid |
| 4 | St. Jude Children's Research Hospital | Children's Health |
| 5 | World Wildlife Fund | Environment |
| 6 | Feeding America | Hunger Relief |
| 7 | Habitat for Humanity | Housing |
| 8 | NAMI (National Alliance on Mental Illness) | Mental Health |
| 9 | Boys & Girls Clubs of America | Youth Development |
| 10 | Make-A-Wish Foundation | Children's Wishes |

---

### Explanation: State Geo-Blocking (#1)

**What it is:** Automatically detecting a user's IP address when they sign up and blocking paid features if they're in a legally restricted state (Montana, Tennessee, etc.). The alternative is just a checkbox in the ToS: "I confirm I do not reside in a restricted state."

**With the charity pivot, this is now much less critical.** No-one personally profits, so the gambling concern is largely gone. The charitable gaming framework is much more permissive across states.

**Recommendation: Self-certification checkbox only.** No IP blocking. Include the state list in the ToS, require the checkbox, and move on. This is the right call for a personal project.

---

### Explanation: Bullet Lifetime (#2)

**The relationship:** `bullet speed × bullet lifetime = total path per bullet`

At 525 px/s × 8 seconds = **4,200px of path** per bullet. The entire maze is only **832 × 576px**. Each bullet bounces ~8–10 times before expiring. With 5 bullets per tank × 2 tanks = up to **10 bullets simultaneously**, the maze fills up quickly with crisscrossing projectiles.

The original TankTrouble used a **5-bounce limit**, which at typical angles ≈ ~1,000px of travel — bullets disappeared much sooner. The feel was brief, purposeful danger.

At 8 seconds, the feel is "bullet hell" — persistent, overlapping threat from all angles. Neither is wrong, they're just different games. It's a single constant: `BULLET_LIFETIME_SECONDS`. Tune during playtesting.

---

### Explanation: Invite Link Window (#3)

"2 minutes to start a game" needs clarification. Two interpretations:

- **Option A:** The invite link itself expires 2 minutes after creation. If your friend doesn't click the link within 2 minutes, it's dead. (Very short — if sent via text, they might miss it.)
- **Option B:** The link stays valid indefinitely (or for 24 hours), but once the opponent **opens** the link, they have 2 minutes to accept before the reservation times out.

Option B feels much more like Lichess and avoids expired links from missed texts. Recommend Option B.

---

## Shared Constants (Final — `packages/game-engine/constants.ts`)

```typescript
// Physics
export const CELL_SIZE = 64;
export const TANK_WIDTH = 38;
export const TANK_HEIGHT = 46;
export const BARREL_LENGTH = 22;
export const TANK_SPEED = 150;
export const TANK_ROTATION_SPEED = 135;
export const BULLET_SPEED = 525;
export const MAX_BULLETS_PER_TANK = 5;
export const BULLET_LIFETIME_SECONDS = 3;      // time-based expiry; bounces are infinite
export const MAZE_COLS = 13;
export const MAZE_ROWS = 9;

// Rules
export const GRACE_PERIOD_SECONDS = 30;
export const GAME_START_COUNTDOWN_SECONDS = 3;
export const BET_AMOUNTS_CENTS = [100, 200, 500] as const;  // $1, $2, $5
export const MIN_DEPOSIT_CENTS = 100;                        // $1
export const WITHDRAWAL_FEE_CENTS = 25;                      // $0.25

// Server
export const SERVER_TICK_HZ = 20;
export const CLIENT_FPS = 60;
export const INTERPOLATION_DELAY_MS = 100;
```
