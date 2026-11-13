import unittest

from stock import restock_needed


class RestockTest(unittest.TestCase):
    def test_shelves_under_the_minimum_by_name(self):
        self.assertEqual(restock_needed({'tea': 2, 'rice': 9, 'beans': 0}, 3), ['beans', 'tea'])

    def test_a_shelf_at_the_minimum_is_full_enough(self):
        self.assertEqual(restock_needed({'tea': 3}, 3), [])


if __name__ == '__main__':
    unittest.main()
