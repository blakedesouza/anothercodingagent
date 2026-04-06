/**
 * Monotonic sequence number generator.
 * One instance per session — produces strictly increasing integers starting from 1.
 */

export class SequenceGenerator {
    private current: number;

    constructor(startAfter = 0) {
        this.current = startAfter;
    }

    next(): number {
        return ++this.current;
    }

    peek(): number {
        return this.current + 1;
    }

    value(): number {
        return this.current;
    }
}
