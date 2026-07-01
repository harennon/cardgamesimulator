import type { Card } from "@shared/engine-types";
import type { Walkthrough } from "./walkthroughTypes";

// Hard-coded fixture cards. These are static literals — never live game state
// (LLD 111 decision 7). Terse constructor keeps the step data readable.
const card = (rank: Card["rank"], suit: Card["suit"]): Card => ({ rank, suit });

// The ~6-step Big2 walkthrough. Shape and step count are fixed by the LLD;
// fixtures + wording finalized against the approved mockup.
export const BIG2_WALKTHROUGH: Walkthrough = [
  {
    tag: "Rank order",
    scene: {
      kind: "cards",
      cards: [
        card("3", "clubs"),
        card("7", "spades"),
        card("10", "hearts"),
        card("K", "diamonds"),
        card("2", "spades"),
      ],
      highlightIndices: [0],
    },
    caption: [
      { text: "Cards rank " },
      { strong: "3 (lowest) up to 2 (highest)" },
      {
        text: ". Suit breaks ties: ♣ < ♦ < ♥ < ♠. The holder of the ",
      },
      { strong: "3♣" },
      { text: " leads the very first trick." },
    ],
  },
  {
    tag: "Legal combinations",
    scene: {
      kind: "cards",
      cards: [
        card("9", "clubs"),
        card("9", "hearts"),
        card("9", "diamonds"),
        card("4", "hearts"),
        card("4", "clubs"),
      ],
    },
    caption: [
      { text: "Play " },
      { strong: "singles, pairs, or five-card hands" },
      {
        text: " (straight, flush, full house, four-of-a-kind, straight flush). You must match the count of the current play.",
      },
    ],
  },
  {
    tag: "Winning a trick",
    scene: {
      kind: "cards",
      cards: [
        card("3", "clubs"),
        card("6", "spades"),
        card("8", "diamonds"),
        card("J", "hearts"),
      ],
      highlightIndices: [0],
    },
    caption: [
      { text: "When everyone else passes you " },
      { strong: "win the trick" },
      { text: " and lead the next one — lead your " },
      { strong: "lowest" },
      { text: " cards to save the high ones." },
    ],
  },
  {
    tag: "Select, then play",
    scene: {
      kind: "cards",
      cards: [
        card("3", "clubs"),
        card("5", "diamonds"),
        card("9", "spades"),
        card("J", "hearts"),
        card("K", "clubs"),
      ],
      selectedIndices: [0, 1],
    },
    caption: [
      { text: "Tap cards to select, then " },
      { strong: "Play" },
      { text: " to beat the current play or " },
      { strong: "Pass" },
      { text: " if you can't or won't." },
    ],
  },
  {
    tag: "Reading the table",
    scene: {
      kind: "cards",
      cards: [card("7", "spades"), card("7", "hearts")],
    },
    caption: [
      { text: "The center shows the " },
      { strong: "last play" },
      {
        text: " you must beat; the log and seats show whose turn it is and who has passed.",
      },
    ],
  },
  {
    tag: "Winning & scoring",
    scene: {
      kind: "callout",
      icon: "\u{1F3C6}",
      lines: ["1st = 5 pts · 2nd = 3 · 3rd = 1 · 4th = 0"],
    },
    caption: [
      { text: "First to empty their hand " },
      { strong: "wins the round" },
      {
        text: ". Placement decides points — fewer cards left is better.",
      },
    ],
  },
];
