/** Original spade and mirror-diamond mark for the standalone edition. */
export type MarkCommand = readonly ['M' | 'L', number, number]
  | readonly ['Q', number, number, number, number] | readonly ['Z']
const commands: readonly MarkCommand[] = [["M", 450, 20], ["Q", 400, 105, 200, 280], ["Q", 20, 430, 150, 560], ["Q", 270, 675, 420, 540], ["L", 350, 740], ["L", 550, 740], ["L", 480, 540], ["Q", 630, 675, 750, 560], ["Q", 880, 430, 700, 280], ["Q", 500, 105, 450, 20], ["Z"], ["M", 450, 250], ["L", 570, 390], ["L", 450, 510], ["L", 330, 390], ["Z"]]
export const POKER_MARK = {
  assetURL: 'assets/brand/poker-mark.svg', width: 900, height: 804,
  viewBox: '0 0 900 804', fillRule: 'evenodd',
  path: "M450 20 Q400 105 200 280 Q20 430 150 560 Q270 675 420 540 L350 740 L550 740 L480 540 Q630 675 750 560 Q880 430 700 280 Q500 105 450 20 Z M450 250 L570 390 L450 510 L330 390 Z", facePath: "M450 20 Q400 105 200 280 Q20 430 150 560 Q270 675 420 540 L350 740 L550 740 L480 540 Q630 675 750 560 Q880 430 700 280 Q500 105 450 20 Z", commands,
} as const
export const POKER_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 804" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><path d="M450 20 Q400 105 200 280 Q20 430 150 560 Q270 675 420 540 L350 740 L550 740 L480 540 Q630 675 750 560 Q880 430 700 280 Q500 105 450 20 Z" fill="#fff"/><path d="M450 20 Q400 105 200 280 Q20 430 150 560 Q270 675 420 540 L350 740 L550 740 L480 540 Q630 675 750 560 Q880 430 700 280 Q500 105 450 20 Z M450 250 L570 390 L450 510 L330 390 Z" fill="#000" fill-rule="evenodd"/></svg>`
