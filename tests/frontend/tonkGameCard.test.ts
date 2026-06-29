import { describe, it, expect } from "vitest";
import { ref, computed } from "vue";
import type { Card } from "../../src/shared/engine-types.js";
import type { TonkCard } from "../../src/shared/tonk-types.js";
import { isJoker } from "../../src/shared/tonk-types.js";

// Transcription of GameCard.vue's <script setup> joker-aware derivation (LLD 88
// decision 5), tested in isolation per the project pattern. The template renders
// the joker icon face iff `joker` is true (and never rank/suit text), else the
// standard rank/suit face — so asserting these computeds asserts which face the
// template draws and that the Big2 path is unchanged.

const SUIT_SYMBOLS: Record<string, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

function makeGameCardLogic(card: ReturnType<typeof ref<Card | TonkCard>>) {
  const joker = computed(() => isJoker(card.value as TonkCard));
  const suitSymbol = computed(() =>
    joker.value ? "" : (SUIT_SYMBOLS[(card.value as Card).suit] ?? ""),
  );
  const suitColorClass = computed(() => {
    if (joker.value) return "black";
    const suit = (card.value as Card).suit;
    return suit === "hearts" || suit === "diamonds" ? "red" : "black";
  });
  const displayRank = computed(() =>
    joker.value ? "" : (card.value as Card).rank,
  );
  return { joker, suitSymbol, suitColorClass, displayRank };
}

describe("GameCard — joker support (additive, Big2 unaffected)", () => {
  it("a standard red card renders rank + suit symbol with red class (no regression)", () => {
    const t = makeGameCardLogic(
      ref<Card | TonkCard>({ rank: "A", suit: "hearts" }),
    );
    expect(t.joker.value).toBe(false);
    expect(t.displayRank.value).toBe("A");
    expect(t.suitSymbol.value).toBe("♥");
    expect(t.suitColorClass.value).toBe("red");
  });

  it("a standard black card renders rank + suit symbol with black class", () => {
    const t = makeGameCardLogic(
      ref<Card | TonkCard>({ rank: "10", suit: "spades" }),
    );
    expect(t.joker.value).toBe(false);
    expect(t.displayRank.value).toBe("10");
    expect(t.suitSymbol.value).toBe("♠");
    expect(t.suitColorClass.value).toBe("black");
  });

  it("a joker renders the icon face: no rank, no suit symbol (icon path)", () => {
    const t = makeGameCardLogic(ref<Card | TonkCard>({ joker: true, id: 0 }));
    expect(t.joker.value).toBe(true);
    // The icon face shows neither rank nor suit text — the glyph is in the
    // template's .card__joker-icon span, never the literal word "Joker".
    expect(t.displayRank.value).toBe("");
    expect(t.suitSymbol.value).toBe("");
  });
});
