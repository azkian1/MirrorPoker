# Heratexx CC0 vector card source

Author: Heratexx. Original work: **Classic 4-Color Poker Deck (SVG)**.
Author's upload and CC0 declaration, inspected 15 October 2026:
https://opengameart.org/content/classic-4-color-poker-deck-svg

Original archive:
https://opengameart.org/sites/default/files/4color_deck_by_heratexx.zip

Archive SHA-256: `2892FDBAA68E47EEF618F2A4A34F2A1F532FE2030CCAE4F0206B1482E853C5BA`.
Original As.svg SHA-256: `E1BFA8B5BF237CBA8DF8B58087EF3A200E2EBAD2DF56A1870C49635F6EC83BA2`.

The upload declares CC0. The ZIP contains 52 SVGs and has no separate licence
file. The complete CC0 1.0 legal text is retained as `CC0-1.0.txt`, downloaded
from https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt . The author's
original thirteen spade SVGs are retained unchanged here: each contains its rank
path plus all four suit paths, so these are the complete vector sources used.
The remaining 39 donor layouts are not needed by the adapted common factory.

Adaptation in `shared/card-art.ts` / `scene/cards.ts`, 15 October 2026:

- Copy the thirteen exact rank and four suit outline paths; no external font.
- Increase rank stroke from 110 to 150 source units, round caps/joins and enlarge
  the index into one consistent jumbo footprint. A ten remains two real digits.
- Centre every pip by its actual SVG path bounds; club source centre differs
  from the donor viewBox centre.
- Use the project's four existing suit colours and near-white paper. Replace
  donor multi-pip/court layouts with two mirrored indices and one central pip.
- Add a rounded physical paper shape and thin neutral print rim; retain the
  game's original M/lime/forest back, with thinner margins and quieter hatching.
- Provide a compact rank/pip SVG variant for LAST HAND from the same outlines.

The author does not require attribution under CC0; this source record is kept
for traceability. No proprietary poker-room skin, React wrapper, npm package,
generated image, or external font is included.
