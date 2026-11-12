package example.tally;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class TallyTest {
    @Test
    void addsTwoCounts() {
        assertEquals(5, Tally.add(2, 3));
    }
}
