import type { Card } from "@shared/engine-types";
import type { TonkJoker } from "@shared/tonk-types";
import type { Walkthrough } from "./walkthroughTypes";

// Hard-coded fixture cards. These are static literals — never live game state
// (LLD 111 decision 7). Terse constructors keep the step data readable.
const card = (rank: Card["rank"], suit: Card["suit"]): Card => ({ rank, suit });
const joker = (id: number): TonkJoker => ({ joker: true, id });

// The 6-step Tonk walkthrough. Shape, step count, and the four required topics
// (discard-first/draw, jokers, TONK, loss-centric scoring) are fixed by LLD 115;
// wording is faithful to the Tonk rules of record (LLD 65).
export const TONK_WALKTHROUGH: Walkthrough = [
  {
    tag: "Aim of the game",
    scene: {
      kind: "cards",
      cards: [
        card("A", "spades"),
        card("4", "hearts"),
        card("7", "clubs"),
        card("10", "diamonds"),
        card("K", "spades"),
      ],
      highlightIndices: [0, 1],
    },
    caption: [
      { text: "You always hold a " },
      { strong: "5-card hand" },
      { text: " — it's never emptied. Race for the " },
      { strong: "lowest hand value" },
      { text: ": " },
      { strong: "A = 1, 2–10 = face value, J/Q/K = 10" },
      { text: "." },
    ],
  },
  {
    tag: "Discard first",
    scene: {
      kind: "cards",
      cards: [
        card("Q", "clubs"),
        card("Q", "hearts"),
        card("Q", "diamonds"),
        card("5", "spades"),
        card("8", "hearts"),
      ],
      selectedIndices: [0, 1, 2],
    },
    caption: [
      { text: "Every turn you " },
      { strong: "discard first" },
      { text: " — one card, or " },
      { strong: "several of the same rank" },
      { text: " (three Queens here)." },
    ],
  },
  {
    tag: "…then draw one",
    scene: {
      kind: "cards",
      cards: [card("6", "clubs"), card("9", "hearts")],
      highlightIndices: [0],
    },
    caption: [
      { text: "Then " },
      { strong: "draw exactly one" },
      { text: " — from the " },
      { strong: "stock" },
      { text: " or the highlighted " },
      { strong: "face-up discard" },
      { text: ". You can " },
      { strong: "never draw back your own discard" },
      { text: "." },
    ],
  },
  {
    tag: "Jokers are gold",
    scene: {
      kind: "cards",
      cards: [joker(0)],
    },
    caption: [
      { text: "A " },
      { strong: "Joker is worth 0" },
      {
        text: " — the best card you can hold. Keep it to crush your hand value.",
      },
    ],
  },
  {
    tag: "Call TONK",
    scene: {
      kind: "callout",
      icon: "\u{1F514}",
      lines: ["Beat everyone → you add 0", "Get caught → +30"],
    },
    caption: [
      { text: "Declare " },
      { strong: "TONK" },
      { text: " at the " },
      { strong: "start of your turn" },
      { text: ". Beat everyone and you add " },
      { strong: "0" },
      { text: " while they take their hand value — but a " },
      { strong: "failed call costs 30" },
      { text: "." },
    ],
  },
  {
    tag: "Scoring — low is safe",
    scene: {
      kind: "callout",
      icon: "\u{1F4C9}",
      lines: ["Points add up each trick", "Hit 150 → game ends"],
    },
    caption: [
      { text: "Points " },
      { strong: "add up" },
      { text: " each trick — " },
      { strong: "low is safe" },
      { text: ". When someone hits " },
      { strong: "150" },
      { text: " the game ends with exactly " },
      { strong: "one true loser" },
      { text: "; everyone else " },
      { strong: "wins" },
      { text: "." },
    ],
  },
];
