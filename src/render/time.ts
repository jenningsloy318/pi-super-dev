function pad(value: number, size = 2): string {
	return String(value).padStart(size, "0");
}

/** Local ISO-like timestamp with numeric timezone offset.
 * Example: 2026-08-06T21:36:33.429+08:00 */
export function localTimestamp(date = new Date()): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetMinutes);
	return [
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
		"T",
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
		`.${pad(date.getMilliseconds(), 3)}`,
		sign,
		`${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`,
	].join("");
}
