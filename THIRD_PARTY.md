# Third-party sources

## Three.js and build tooling

- Runtime renderer: Three.js 0.185.0, installed from npm and bundled locally.
- License: MIT, https://github.com/mrdoob/three.js/blob/dev/LICENSE.
- The standalone edition does not redistribute or require the Remix SDK, host bridge, or server runtime.
- Vite, TypeScript, esbuild and Playwright are development dependencies pinned in package-lock.json; their package distributions retain their own notices.
- The spade/diamond brand mark, procedural geometry, textures, interface layout and event cues are original project code.

## Heratexx card vectors

- Source: https://opengameart.org/content/classic-4-color-poker-deck-svg.
- Author: Heratexx, Classic 4-Color Poker Deck (SVG), 13 April 2026.
- License: CC0 1.0, explicitly marked on the author's source page.
- Adapted rank and suit paths appear on table cards and in LAST HAND. Layout,
  sizing, centring, colours, paper materials and card backs are project adaptations.
- Retained originals: thirteen SVGs under `assets/cards/heratexx-source/`, each
  containing four suits; `SOURCE.md` and `CC0-1.0.txt` retain provenance and terms.
- Runtime paths live in `shared/card-art.ts`; no card font or remote request is needed.

## poker-ts

- Source: https://github.com/claudijo/poker-ts.
- Pinned revision: `1214cd8fc77ad78728be49cff477e19475abba7b`.
- Upstream package version: 1.5.0.
- Copyright: Claudijo Borovic, 2021.
- License: MIT; the complete required notice remains in `vendor/poker-ts/LICENSE`.
- Upstream acknowledgment: poker-ts is a TypeScript port of Janko Dedic's C++
  Poker library, https://github.com/JankoDedic/poker, with some API differences.
- Retrieved on 15 October 2026 by a public read-only Git clone. The vendored tree
  contains adapted source, without an embedded Git checkout or installed package.
- Used modules: table, dealer, betting round, round, players, chips, deck, cards,
  community cards, pots, local types and utilities under `vendor/poker-ts/src/`.
  The unused facade, upstream build setup and Jest tests are omitted.

Local adaptations:

- Local assertions replace Node `assert`; an injected Fisher-Yates random source
  replaces Node `crypto.randomInt`; type imports use relative local paths.
- The single world-aware evaluator examines every five-card subset of five to
  seven actual cards, preserving identities and standard category precedence.
  MIRROR reverses ranks and uses its approved straight and royal order.
- Evaluation also handles two triples and the kicker of four of a kind correctly.
- Betting validates action membership, short all-in minimum raises and reopening
  rights; zero-stack players do not act, but remain eligible for their pots.
- Pot accounting uses cumulative contribution caps, excludes folded hands from
  eligibility and retains split payouts and clockwise odd-chip distribution.
- `Deck` sets array species; `Table` exposes current bet, minimum raise and
  injected shuffle; showdown receives the selected world mode.
- A sole solvent player already covering surviving all-ins runs out immediately,
  including after later actions; meaningful free checks can still fold. Multiway
  preflop betting retains the nominal big-blind bring-in after a short blind post.
  When only one solvent player remains, calls use the actual surviving all-in cap.
  Showdown rejects an empty eligible set before distributing odd chips.
- Starting heads-up after eliminations adjusts the button when necessary to avoid
  charging the surviving previous big blind twice in a row.
- An uncontested hand pays its sole remaining non-folded player across all pots
  without revealing new board cards or evaluating the private hand. Contested
  all-in hands still receive the full board runout.

The authoritative `core/engine.ts` adapter, limited-information bot policy,
wire/session integration and regression tests are original project code. No
third-party bot heuristic was copied. Local checks are described in `Project.md`;
they cover the standalone browser edition.

The adapter also reserves disconnected match seats and supports two-player
physical seats 0 and 3. Voluntary surrender folds only at a legal turn and retains
all-in eligibility through the original payout. After payout, surrendered balances
are divided equally among the remaining current-hand participants before
elimination, including folded and zero-stack hands. Odd residue chips go clockwise
after the button. Between hands, only funded remaining players receive residue;
already eliminated players cannot regain chips. Residue burns only when no eligible
recipient remains. This tournament settlement policy is original project code.

## Kenney Casino Audio

- Source: https://kenney.nl/assets/casino-audio.
- Author: Kenney (www.kenney.nl), Casino Audio pack, 50 source sounds.
- License: CC0 1.0; the original notice remains at `assets/audio/License.txt`.
- Thirteen original OGG recordings remain under `assets/audio/` as retained source
  recordings for card slides, placement, shove and shuffle, plus chip taps,
  handling and stacking. Runtime playback uses same-basename PCM WAV conversions
  for consistent browser decoding.
- Event mapping, trims and the mixer are project code in `audio/`.

## Joseph SARDIN / BigSoundBank finger snap

- Creator: Joseph SARDIN / BigSoundBank.com; original title: Finger clashes, sound 0483.
- Source: https://bigsoundbank.com/finger-clashes-s0483.html.
- License: Creative Commons Zero, CC0 1.0 Universal; source terms at
  https://bigsoundbank.com/licenses.html.
- Retrieved and license verified on 15 October 2026. The original recording's
  embedded metadata also identifies CC0 / WTFPL / Public domain.
- The original WAV is retained at `references/audio-source/bigsoundbank-0483-source.wav`;
  its SHA-256 matches the original recording hash in `assets/audio/finger-snap-license.txt`.
- `assets/audio/finger-snap.wav` contains one real 200 ms snap extracted from
  3.369 seconds of the source, with a 90 Hz high-pass, short entrance/tail fades
  and 6 dB gain, stored as mono 48 kHz 16-bit PCM.
- `assets/audio/finger-snap-license.txt` retains exact source links, adaptation,
  FFmpeg filter and the original/adapted SHA-256 hashes. Runtime playback uses the
  project mixer and the Dealer's presentation release cue; the sound is not synthesized.

## Generated dealer art

- Built-in `image_gen` created the original fictional adult dealer and its
  costume variants. Current RGBA body assets are `assets/dealer/normal-v3.png`
  and `assets/dealer/mirror-v3.png`; the game recolours their clothing at runtime.
- `assets/dealer/head-natural-v14.png` is an `image_gen` edit of the retained
  user-supplied `assets/dealer/head-reference-v10.png`, removing facial cosmetics
  while preserving the smile, hairstyle and alignment. The material samples
  only its head UV region; the existing body assets provide the costume and hands.
- Built-in `image_gen` also created `assets/dealer/snap-raise-1-v15.png`,
  `snap-raise-2-v15.png`, `snap-ready-v15.png` and `snap-release-v15.png` as aligned
  dark-costume pose edits of the existing dealer. Native ivory counterparts are
  `snap-raise-1-mirror-v16.png`, `snap-raise-2-mirror-v16.png`,
  `snap-ready-mirror-v16.png` and `snap-release-mirror-v16.png` in the same directory.
  The approved head and visible torso remain fixed; a separate articulated surface
  samples only the viewer-right sleeve and glove from the matching costume pose.
  A constant pose plate fills only the waist previously hidden by the resting glove.
  Red trim in the source artwork is a selection mask; the material maps it to the
  approved forest green `#17452f` in both worlds.
- User-supplied hand references guided finger positions only, preserving the
  generated dealer's style and costume. `assets/dealer/snap-v16.json` records the
  current costume pairs, source artwork, generation prompt and rendering policy.
  The retained dark poses and `assets/dealer/snap-v15.json` preserve the earlier
  finger-pose prompts and cue timing.
