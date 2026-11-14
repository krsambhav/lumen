/**
 * What ⌘Z would do right now (DESIGN.md §8): the last thing that offered
 * Undo, for as long as its toast is up. Whatever shows such a toast offers
 * its undo here and withdraws it when the toast goes.
 */

interface Offer {
  /** The id of the toast that makes the offer. */
  id: string;
  run: () => void;
}

const offers: Offer[] = [];

/** Offers an undo. A second offer under the same id replaces the first. */
export function offerUndo(id: string, run: () => void): void {
  withdrawUndo(id);
  offers.push({ id, run });
}

/** Takes an offer back: its toast has gone, or it has been taken up. */
export function withdrawUndo(id: string): void {
  const at = offers.findIndex((offer) => offer.id === id);
  if (at >= 0) {
    offers.splice(at, 1);
  }
}

export function canUndo(): boolean {
  return offers.length > 0;
}

/**
 * Takes up the newest offer. Returns the id of the toast that made it, so
 * that the toast can be closed, or `null` if there was nothing to undo.
 */
export function undoLast(): string | null {
  const offer = offers.pop();
  if (!offer) {
    return null;
  }
  offer.run();
  return offer.id;
}

/** Forgets every offer. For tests. */
export function clearUndo(): void {
  offers.length = 0;
}
