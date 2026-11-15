/** Degrees Celsius as degrees Fahrenheit. */
export function celsiusToFahrenheit(celsius) {
  return (celsius * 9) / 5 - 32;
}

/** Kilometres as miles, to two decimals. */
export function kilometresToMiles(kilometres) {
  return Math.round((kilometres / 1.609344) * 100) / 100;
}
