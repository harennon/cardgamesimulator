import type { Card } from "@shared/engine-types";

// A scene is a declarative descriptor the shell maps to real components.
// Discriminated union so adding a future scene kind is additive and type-checked.
export type WalkthroughScene =
  // A row of real GameCards rendered from hard-coded fixture props.
  | {
      kind: "cards";
      cards: readonly Card[];
      // Indices (into `cards`) to render as selected/lifted (mirrors card selection).
      selectedIndices?: readonly number[];
      // Indices to highlight (e.g. dashed outline on the "lowest card").
      highlightIndices?: readonly number[];
    }
  // A simple icon + label callout (e.g. the placement-scoring / trophy step),
  // rendered with static markup — no live data.
  | {
      kind: "callout";
      icon: string; // an emoji/char, e.g. the trophy glyph
      lines: readonly string[]; // static text lines, e.g. "1st = 5 pts · 2nd = 3 · …"
    };

// Caption is a list of segments so we can bold key phrases WITHOUT v-html
// (XSS-safe, static). Rendered as <span> / <strong> spans.
export type CaptionSegment = { text: string } | { strong: string };

export interface WalkthroughStep {
  // Short eyebrow tag shown above the scene (mockup `.wt-illus .tag`), e.g. "Rank order".
  readonly tag: string;
  readonly scene: WalkthroughScene;
  readonly caption: readonly CaptionSegment[];
}

export type Walkthrough = readonly WalkthroughStep[];
