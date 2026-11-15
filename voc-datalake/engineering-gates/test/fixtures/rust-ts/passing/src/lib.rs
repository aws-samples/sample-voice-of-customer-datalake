//! Tally: adds up the votes of a fictional feedback board.

/// The sum of two vote counts.
pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::add;

    #[test]
    fn adds_two_counts() {
        assert_eq!(add(2, 3), 5);
    }
}
