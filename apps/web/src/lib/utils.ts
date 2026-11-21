export { cn } from 'cn';

const COUNT_FORMAT = new Intl.NumberFormat('en-US');

/**
 * Thousands-grouped integer with a fixed locale. `toLocaleString()` uses the
 * runtime's locale, which differs between the server and the browser and
 * breaks hydration ("260,000" vs "2,60,000").
 */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}
