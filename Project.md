# Mirror Poker: standalone architecture

This repository is the browser edition of Mirror Poker. It runs one human and three bots entirely on the player's computer. There is no network authority or external SDK.

## Entry and build

- `index.html` supplies the canvas/HUD mounts and accessible loading/error panel.
- `game-main.ts` creates the Three.js renderer, scene, camera, pieces, Dealer, audio and DOM controls.
- `vite.config.ts` builds with relative URLs and copies local `assets/` into `dist/assets/`.
- `package.json` and `package-lock.json` pin the runtime and development tools.
- `start-preview.cmd` checks Node.js, installs from the lockfile when needed, and opens the development server on Windows.
- `tsconfig.json` checks strict ES2022 TypeScript without emitting source files.

The runtime imports Three.js from the npm package; the build includes it locally. Assets and audio use relative URLs. Browser safe-area environment variables position overlays on phones.

## Rules and session

- `core/evaluator.ts` evaluates actual physical cards in HOLDEM and MIRROR. It examines five-card subsets, keeps standard category precedence, and reverses rank/kicker strength and straight ordering in MIRROR.
- `core/engine.ts` adapts `vendor/poker-ts/` for world selection, public/private state, legal actions, side pots, payouts and tournament placements.
- `core/bots.ts` chooses legal actions using only the acting bot's observation. It cannot inspect opponents' unrevealed cards.
- `server/session.ts` runs in the browser despite the historical directory name. `PokerSession` owns the engine, bots, hand progression, decisions and turbo levels.
- `shared/contracts.ts` defines commands, addressed snapshots, events, cards, legal actions and placements.
- `shared/profiles.ts` contains bounded display-profile helpers and format seat counts; it has no account or network integration.
- `shared/tournament.ts` owns the starting stack, blind schedule and turn/AFK constants.

The session starts 1,000-chip stacks with 10/20 blinds. Levels last three minutes of match time and apply between hands. A running hand keeps its posted blinds. Human decisions last 30 seconds; after two consecutive timeouts, later decisions last 10 seconds until a manual action succeeds. Expiry folds even with a free check.

A single remaining non-folded hand wins without exposing hole cards or drawing unnecessary board cards. Contested all-ins run out the board; side pots and split payouts retain eligibility and clockwise odd-chip rules. Zero-stack players contesting a pot remain in the hand until settlement.

## Local integration

`startLocal()` creates a fresh session, joins `You`, starts Solo and starts its clock. `send()` unlocks audio, suppresses duplicate pending actions and delivers commands directly to the session. `receive()` passes addressed session messages to `StateReceiver`.

- `client/state.ts` installs current snapshots and deduplicates scoped animation events.
- `client/clock.ts` advances session time independently of render frames, with bounded catch-up.
- `client/turn-warning.ts` issues one five-second warning per local decision.
- `client/world-transition.ts` synchronizes the chosen world with the Dealer's finger snap. Initial state, hidden tabs and resync do not replay old gestures.
- `client/result-presentation.ts` waits for settled cards and a visible final-hand viewing interval before showing the result.

Leaving stops the local clock, drops the session and restores the menu. Replay opens the rules screen before creating a new tournament. Page unload disposes resources; restoring a cached page retains its existing scene. Reloading starts over.

## Scene and art

- `shared/assets.ts` defines scene anchors, dimensions, palette and the local asset manifest.
- `scene/world.ts` draws the table and room, creates procedural surfaces and changes lighting/materials between worlds.
- `scene/cards.ts` creates shared physical card geometry, vector faces and backs.
- `shared/card-art.ts` contains adapted CC0 rank and suit paths for the table and Last Hand.
- `scene/pieces.ts` positions cards, deck, dealer button, bets and pot chips from addressed state and events.
- `scene/dealer.ts` animates the generated Dealer, native costume poses and finger-snap cue.
- `scene/dealer-head.ts` preserves the approved head mapping and body transparency.
- `shared/poker-mark.ts` owns the original spade/diamond vector used by inline player icons and the felt engraving.
- `assets/brand/loading-chip.svg` is embedded in the initial loading panel and used in the menu.
- `assets/dealer/` retains generated bodies, registered poses, head artwork and generation provenance.
- `assets/cards/heratexx-source/` retains the licensed source card SVGs and CC0 terms.

The camera fits desktop and phone-landscape windows without changing table, Dealer or card anchors. Player panels are projected from scene positions. The physical spade mark rotates with MIRROR while mode lettering stays upright.

## Interface and audio

`ui/index.ts` renders the menu, two-world briefing, player panels, legal actions, wager controls, timers, H guide, Last Hand, leave confirmation and tournament result. State owns permissions and values; the UI never invents payouts or legal actions. It preserves modal focus and avoids duplicate action gestures.

`ui/style.css` supplies dark/ivory themes, responsive layout and browser safe-area offsets. The public menu exposes Solo only. There are no matchmaking, account, leaderboard or invitation controls.

`audio/index.ts` mixes local CC0 card/chip recordings, the recorded finger snap, and a short synthesized turn warning. Audio follows the browser gesture requirement and local mute control. Repeated state does not replay sounds; disposal releases audio nodes.

## Verification

- `tests/core*` exercise evaluation, action legality, chip conservation, bots and retained engine behavior across seat counts.
- `tests/session.test.mjs` and `tests/turbo.test.mjs` verify automatic hands, results, timing, AFK and blind boundaries.
- Remaining `*.test.mjs` files verify presentation gates, transitions, cards/pieces/dealer geometry, marking and audio scheduling.
- `scripts/test-tools.mjs` invokes the installed esbuild package through Node on supported desktop platforms.
- `tests/browser/standalone.spec.ts` runs the production build without a host SDK, checks local-only requests, starts a bot table, exercises guide/leave flow, advances hands and checks landscape layout.
- `tests/cards-v4.browser.mjs` renders all 52 card faces with Chromium/WebGL.
- `tests/ui-v2.mjs`, `ui-turbo.mjs` and `ui-help.mjs` retain detailed DOM/layout regressions.
- `tests/audio-v2-browser.mjs` checks real WAV decoding and audio signal/lifecycle behavior.
- `playwright.config.ts` serves `dist/` locally for the integration checks.

`npm run check` runs units and the production build. `npm run test:browser` runs Chromium checks after building. These checks establish local browser behavior; physical phones still require device testing.

## Provenance and generated output

`README.md` records the live-version comparison and user-facing launch commands. `THIRD_PARTY.md`, source notices and the root MIT `LICENSE` retain licensing information. `AGENTS.md` describes contributor constraints.

Ignored output: `node_modules/`, `dist/`, `.test-output/`, `.local-check/`, `test-results/` and `playwright-report/`. No account data, credentials, platform bridge, generated SDK declarations or platform server entry is part of this edition.
