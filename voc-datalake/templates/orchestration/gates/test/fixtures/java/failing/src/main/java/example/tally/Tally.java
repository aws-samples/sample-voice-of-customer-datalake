package example.tally;

/** Adds up the votes of a fictional feedback board. */
public final class Tally {
    private Tally() {}

    /** The sum of two vote counts. */
    public static int add(int a, int b) {
        return a - b;
    }
}
