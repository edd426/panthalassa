/**
 * The layer composition point (R1).
 *
 * The shell knows nothing about what it is drawing: it mounts this list in
 * order, calls `update` on each once per frame, and renders. Adding a layer is
 * a one-line change here and nowhere else.
 *
 * Registry order only decides draw order *within* a slot — the five slots are
 * z-ordered by the shell — so a layer that owns `creatures` or `backdrop` can
 * be spliced in anywhere. The two layers below both live in `waterAbove`, and
 * there the order does matter: the diagnostic overlay is mounted first so the
 * selection halo stays legible on top of it.
 */

import { createFieldOverlayLayer } from './fieldOverlay';
import { createSelectionLayer } from './selectionLayer';
import type { RenderLayer } from './contracts';

export function createLayers(): RenderLayer[] {
  return [
    // INTEGRATION POINT: R3's ambience layers (backdrop / waterBelow /
    // foreground) and R2's creature layer (creatures) splice in here. They are
    // landing in parallel with this file; do not import them until they exist.
    createFieldOverlayLayer(),
    createSelectionLayer(),
  ];
}
