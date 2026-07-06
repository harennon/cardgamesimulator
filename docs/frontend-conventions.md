# Frontend Conventions — cardgamesimulator

Project-specific UI domain knowledge and visual conventions for the card game
simulator. The shared `frontend-architect` and `qa` agents read this file (via
`project.json` → `docs.frontendConventions`) for the card-game expertise and visual
direction that used to be hardcoded into their personas.

## Domain Knowledge: Card Game UIs

Card game interface conventions this project follows:

- **Hand layout**: Fan/arc arrangements, overlap for density, spread on hover
- **Card rendering**: SVG or CSS-based cards, face/back states, suit colors
- **Selection affordance**: Raise-on-click, highlight border, multi-select with shift
- **Board layout**: Opponents positioned around the table (top/sides), play area center, player hand bottom
- **Turn indication**: Glow, pulse, or border highlight on active player
- **Game log**: Scrolling feed of recent actions, compact notation
- **Animation**: Deal animations, card play trajectories, trick collection
- **Information density**: Card counts, timer, turn indicator, last play — all visible without scrolling

## Design Principles

- **Desktop-first**: Card games need screen real estate. Design for 1280px+ first, adapt down.
- **Information always visible**: Card counts, turn indicator, timer, last play — never hidden behind a click.
- **Obvious affordances**: If it's your turn, you KNOW. If a card is selected, it's CLEARLY selected.
- **Minimal chrome**: The cards and the game state ARE the UI. Minimize navigation, headers, decorative elements.
- **Performance**: No heavy JS animation libraries. CSS transitions/animations first. GPU-composited transforms.
- **Accessibility**: Color is not the only differentiator (suit symbols matter). Focus states. Screen reader landmarks.

## Tech Constraints

- Vue 3 Composition API (no Options API)
- Vite bundler
- No UI component library (custom components)
- No Tailwind — plain CSS with variables
- Socket.IO for real-time state (`useSocket` composable exists)
- Types from `src/shared/engine-types.ts` (Card, PlayerView, etc.)

## Approved Visual Direction — "The Club"

The chosen aesthetic direction is `design-mockups/direction-a-revised.html` ("The Club"
felt-table aesthetic). QA validates frontend implementations against this; the
frontend-architect designs new mockups consistent with it.

- **Color palette**: deep greens, warm golds, mahogany browns, aged cream
- **Typography**: DM Sans for UI, Libre Baskerville for card ranks
- **Card selection affordance**: raise + gold border/glow
- **Layout structure**: opponents top, play area center, hand bottom, log right
- **Turn indicator**: gold pill with pulse animation
- **Interactive states**: consistent hover, selected, disabled treatments

## Interaction Principles (for QA validation)

- **Zero friction:** Can a guest join via link without signing up?
- **State visible:** Is turn, last play, and card counts always shown?
- **Actions obvious:** Are valid actions clearly enabled/disabled?
- **Errors recoverable:** Does disconnect/timeout recover gracefully?
- **No dead ends:** Is there always a clear next action?
- **Guests first-class:** Is the experience identical during gameplay?
