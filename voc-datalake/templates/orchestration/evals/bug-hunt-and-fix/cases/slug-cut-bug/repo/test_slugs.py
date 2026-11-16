import unittest

from slugs import slugify


class SlugifyTest(unittest.TestCase):
    def test_words_are_joined_by_single_hyphens(self):
        self.assertEqual(slugify('Hello,  World!'), 'hello-world')

    def test_a_long_title_is_cut_at_a_word_boundary(self):
        self.assertEqual(slugify('Quarterly report on returns', max_length=20), 'quarterly-report-on')

    def test_a_slug_may_be_exactly_max_length(self):
        self.assertEqual(slugify('Quarterly report', max_length=16), 'quarterly-report')

    def test_nothing_but_separators_gives_an_empty_slug(self):
        self.assertEqual(slugify('--- !!! ---'), '')


if __name__ == '__main__':
    unittest.main()
