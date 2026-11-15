/**
 * A short label for a number of seconds: 45 is "45s", 125 is "2m 5s".
 * @param {number} seconds a whole number from 0
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new RangeError('seconds is a whole number from 0');
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}
